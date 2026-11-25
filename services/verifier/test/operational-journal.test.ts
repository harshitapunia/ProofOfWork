import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { LifecycleStore } from "@proofwork/lifecycle";
import { protocolDataDigest, validateHistoricalAdmission } from "../src/operational-protocol.js";
import { proposeJournalModel, appendJournalModel, replayJournalModel, validateJournalCollection,
  JOURNAL_MODEL_MAX_EVENTS, JournalModelError } from "../src/operational-journal-model.js";
import { takeOfflinePolicyMessage } from "../src/transaction-policy.js";
import { journalFixture } from "./journal-model-helpers.js";
function denied(value: any) {
  assert.equal(value.operationalAuthorization, false); assert.equal(value.signingAuthorization, "not_granted");
  for (const key of ["submissionAuthorized", "retryAuthorized", "reservationReleaseAuthorized", "rpcAuthenticated", "onChainStateVerified", "operationalStateMutationAuthorized"])
    assert.equal(value[key], false, key);
  assert.equal(value.reconciliationRequired, true); assert(Object.isFrozen(value));
  const text = JSON.stringify(value); for (const field of ["wireBase64", "signatureBase64", "test_protected_reference"])
    assert(!text.includes(field), field);
}
function rejects(fn: () => unknown, code?: string) { assert.throws(fn, e => e instanceof JournalModelError && (!code || e.code === code)); }
test("model admission, separate role claims, signatures, protected reference and first-send intent replay concretely", () => {
  const f = journalFixture(); f.throughWire(); f.reserve();
  const s = f.summary(); assert.equal(s.admissionState, "accepted_claim"); assert.equal(s.roleClaims.length, 4);
  assert.equal(s.firstSendReservedClaim, true); assert.equal(s.wireReferenceDigest, protocolDataDigest("test_protected_reference"));
  assert.equal(f.model().events.length, 8); denied(f.model()); denied(s);
});
for (const state of ["rejected_claim", "uncertain_claim"]) test("admission " + state + " permanently blocks new role admission", () => {
  const f = journalFixture(); f.push("admission_outcome", { state, operatorApprovalRef: f.f.anchor.operatorApprovalRef });
  rejects(() => f.admit()); rejects(() => f.role(0), "admissions_blocked");
  assert.equal(f.summary().admissionState, state); denied(f.summary());
});
test("accepted admission claim cannot be replayed as another admission outcome", () => { const f = journalFixture(); f.admit(); rejects(() => f.admit(), "duplicate_admission_outcome"); });
test("collection rejects duplicate admission identity", () => {
  const f = journalFixture(), v = { journal: f.model(), evidence: f.evidence };
  rejects(() => validateJournalCollection([v, v]), "duplicate_admission_identity");
});
test("collection rejects duplicate permanent operation under a new admission UUID", () => {
  const f = journalFixture(), c = structuredClone(f.context);
  (c.admission as any).admissionId = c.anchor.intentId;
  const other = proposeJournalModel(c, "other_proposal");
  rejects(() => validateJournalCollection([{ journal: f.model(), evidence: [] }, { journal: other, evidence: [] }]), "duplicate_permanent_operation");
});
test("omitted collection history is not claimed as global replay protection", () => {
  const f = journalFixture(), v = { journal: f.model(), evidence: [] };
  denied(validateJournalCollection([v])[0]); denied(validateJournalCollection([v])[0]);
});
for (const role of [0, 1]) test("replayed role request " + role + " is rejected independently", () => {
  const f = journalFixture(); f.admit(); f.role(role); rejects(() => f.role(role), "replayed_role_admission");
});
for (const role of [0, 1]) test("wrong role public identity " + role + " fails existing validation", () => {
  const f = journalFixture(); f.admit(); (f.f.roles[role] as any).publicKey = role === 0 ? f.f.anchor.feePayer : f.f.anchor.bindings.verifier;
  rejects(() => f.role(role));
});
for (const field of ["genesisHash", "programId", "verifier"]) test("wrong approved binding " + field + " rejects", () => {
  const f = journalFixture(), c = structuredClone(f.context); (c.anchor.bindings as any)[field] = c.anchor.feePayer;
  rejects(() => proposeJournalModel(c, "bad"));
});
for (const field of ["messageDigest", "blockhash", "deadlineUnixMs", "policyVersion", "feePayer"]) test("changed original " + field + " rejects", () => {
  const f = journalFixture(), c = structuredClone(f.context); (c.anchor as any)[field] = field === "deadlineUnixMs" ? "3000" : c.anchor.bindings.verifier;
  rejects(() => proposeJournalModel(c, "bad"));
});
test("changed canonical message fails even when a caller recomputes comparison references", () => {
  const f = journalFixture(), c = structuredClone(f.context), bytes = Buffer.from(c.admission.messageBase64, "base64");
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  (c.admission as any).messageBase64 = bytes.toString("base64");
  (c.admission as any).messageDigest = (c.anchor as any).messageDigest = createHash("sha256").update(bytes).digest("hex");
  rejects(() => proposeJournalModel(c, "bad"));
});
for (const role of [0, 1]) test("invalid or missing signature " + role + " fails actual public verification", () => {
  const f = journalFixture(); f.admit(); f.role(role);
  (f.f.outcomes[role] as any).signatureBase64 = Buffer.alloc(role === 0 ? 64 : 0).toString("base64"); rejects(() => f.sign(role));
});
test("a signature cannot substitute for a prior independent role admission", () => {
  const f = journalFixture(); f.admit(); rejects(() => f.sign(1), "replayed_signing_outcome");
});
test("verifier signature cannot replace payer evidence", () => {
  const f = journalFixture(); f.admit(); f.role(0); f.sign(0); f.role(1);
  (f.f.outcomes[1] as any).signatureBase64 = (f.f.outcomes[0] as any).signatureBase64; rejects(() => f.sign(1));
});
test("partial role signatures cannot create a protected wire reference", () => {
  const f = journalFixture(); f.admit(); f.role(0); f.sign(0); rejects(() => f.wire(), "incomplete_role_signatures");
});
for (const state of ["not_admitted", "signing_rejected", "signing_uncertain"]) test("role admission " + state + " retains exclusion and ambiguity", () => {
  const f = journalFixture(); f.admit(); const o: any = { ...f.accepted(0), state, reason: "test_timeout" };
  if (state === "signing_uncertain") o.receiptRef = null; else delete o.receiptRef;
  f.push("role_admission", { request: f.f.roles[0], outcome: o }); rejects(() => f.role(1), "admissions_blocked"); denied(f.summary());
});
test("signing timeout latches uncertainty and cannot be retried", () => {
  const f = journalFixture(); f.admit(); f.role(0);
  f.push("signing_outcome", { request: f.f.roles[0], outcome: { ...f.accepted(0), state: "signing_uncertain", receiptRef: null, reason: "timeout" } });
  rejects(() => f.sign(0), "replayed_signing_outcome"); rejects(() => f.role(1), "admissions_blocked");
  assert.equal(f.summary().ambiguityRetained, true);
});
for (const patch of [{ nowUnixMs: "2000" }, { currentEpoch: "0" }, { currentEpoch: "2" }, { blockHeight: "201" }]) test("expired/stale admission comparison " + Object.keys(patch)[0] + " rejects effects", () => {
  const f = journalFixture(); f.admit(); rejects(() => f.push("role_admission", { request: f.f.roles[0], outcome: f.accepted(0) }, patch));
});
test("historical evidence validates after expiry without renewing original authorization", () => {
  const f = journalFixture(); f.admit(); f.role(0);
  f.push("signing_outcome", { request: f.f.roles[0], outcome: f.f.outcomes[0] }, { nowUnixMs: "2500" });
  rejects(() => f.role(1)); denied(f.summary());
  assert.equal(validateHistoricalAdmission(f.f.admission, f.f.anchor, { ...f.f.snapshot, nowUnixMs: "2500" }).authenticated, false);
});
test("changed role evidence cannot replace the original consumption identity", () => {
  const f = journalFixture(); f.admit(); f.role(0); f.sign(0); f.role(1); f.sign(1);
  (f.f.outcomes[0] as any).receiptRef = "different_receipt"; rejects(() => f.wire(), "role_evidence_changed");
});
test("missing first-send reservation rejects every possible-invocation claim", () => {
  const f = journalFixture(); f.throughWire(); rejects(() => f.push("submission_outcome", { outcome: f.submission("invocation_potentially_occurred") }), "missing_first_send_reservation");
});
test("one first-send reservation per permanent model cannot be repeated", () => {
  const f = journalFixture(); f.throughWire(); f.reserve(); rejects(() => f.reserve(), "duplicate_first_send_reservation");
});
test("missing acknowledgment retains ambiguity; later acknowledgment does not clear it or permit another send", () => {
  const f = journalFixture(); f.throughWire(); f.reserve();
  f.push("submission_outcome", { outcome: f.submission("submission_uncertain", "rpc_timeout") });
  f.push("submission_outcome", { outcome: f.submission("acknowledgment_received") });
  assert.deepEqual(f.summary().submissionStates, ["submission_uncertain", "acknowledgment_received"]);
  assert.equal(f.summary().ambiguityRetained, true); rejects(() => f.reserve()); denied(f.summary());
});
test("duplicate sender outcome and wrong acknowledgment identity fail", () => {
  const f = journalFixture(); f.throughWire(); f.reserve(); const ack = f.submission("acknowledgment_received");
  f.push("submission_outcome", { outcome: ack }); rejects(() => f.push("submission_outcome", { outcome: ack }), "replayed_submission_outcome");
  const other = journalFixture(); other.throughWire(); other.reserve(); ack.acknowledgmentTransactionId = f.f.anchor.feePayer;
  rejects(() => other.push("submission_outcome", { outcome: ack }));
});
test("intent marker cannot be reordered after possible invocation", () => {
  const f = journalFixture(); f.throughWire(); f.reserve(); f.push("submission_outcome", { outcome: f.submission("invocation_potentially_occurred") });
  rejects(() => f.push("submission_outcome", { outcome: f.submission("intent_recorded") }), "submission_order_conflict");
});
test("shutdown advances epoch, blocks new admissions, and recovery does not reactivate", () => {
  const f = journalFixture(); f.admit(); f.push("shutdown", { operatorApprovalRef: f.f.anchor.operatorApprovalRef }, { currentEpoch: "2" });
  rejects(() => f.role(0), "admissions_blocked");
  rejects(() => f.push("shutdown", { operatorApprovalRef: f.f.anchor.operatorApprovalRef }, { currentEpoch: "1" }));
  f.push("recovery_requirement", { operatorApprovalRef: f.f.anchor.operatorApprovalRef, reason: "operator_review_required" });
  assert.equal(f.summary().shutdownClaim, true); assert.equal(f.summary().epoch, "2"); denied(f.summary());
});
test("late already-admitted signing evidence after shutdown cannot revive role or sender admission", () => {
  const f = journalFixture(); f.admit(); f.role(0);
  f.push("shutdown", { operatorApprovalRef: f.f.anchor.operatorApprovalRef }, { currentEpoch: "2" });
  f.sign(0); assert.equal(f.summary().shutdownClaim, true); assert.equal(f.summary().ambiguityRetained, true);
  rejects(() => f.role(1), "admissions_blocked"); rejects(() => f.wire(), "admissions_blocked"); denied(f.summary());
});
test("MODEL interruption before proposal cannot hydrate an empty journal as admitted", () => {
  const f = journalFixture(), empty = { ...f.model(), events: [] }; rejects(() => replayJournalModel(empty, []));
});
test("forged operator or payer references do not authenticate a capability", () => {
  const f = journalFixture(); rejects(() => f.push("admission_outcome", { state: "accepted_claim", operatorApprovalRef: "wrong_reference" }));
  const c = structuredClone(f.context); (c.anchor as any).operatorApprovalRef = "invented_reference"; (c.admission as any).operatorApprovalRef = "invented_reference";
  denied(proposeJournalModel(c, "comparison_only")); f.admit(); (f.f.roles[1] as any).roleApprovalRef = "invented_reference"; rejects(() => f.role(1));
});
for (const field of ["approved", "authenticated", "privateKey", "sendTransaction"]) test("injected authority/secret field " + field + " is rejected", () => {
  const f = journalFixture(); rejects(() => proposeJournalModel({ ...f.context, [field]: true }, "bad"));
});
for (const finality of ["processed", "confirmed", "finalized"]) test("append-only " + finality + " observation retains non-authenticated provenance", () => {
  const f = journalFixture(); f.throughWire(); f.observe({ transaction: { ...f.f.status, finality } });
  assert.equal(f.summary().observationClaims.length, 1); denied(f.summary());
});
test("missing/RPC-timeout evidence never authorizes submission or clears uniqueness", () => {
  const f = journalFixture(); f.throughWire(); f.observe({ transaction: { kind: "missing", reason: "rpc_timeout" }, accounts: { kind: "not_supplied", reason: "not_read" } });
  assert.equal(f.summary().observationClaims[0]!.classification, "missing_evidence"); rejects(() => f.reserve(), "admissions_blocked");
});
test("conflicting historical outcomes are retained, including a lower-finality claim after finalized success", () => {
  const f = journalFixture(); f.throughWire(); f.observe();
  f.observe({ transaction: { ...f.f.status, finality: "processed", outcome: "failure", errorCode: "InstructionError" } });
  const s = f.summary(); assert.equal(s.observationClaims.length, 2); assert.equal(s.conflictingClaimsRetained, true);
  assert.equal(s.observationClaims[0]!.classification, "matching_finalized_claim"); assert.equal(s.furtherAdmissionsBlocked, true); denied(s);
});
test("finalized failure and incorrect account claims stay distinct from matching state", () => {
  const f = journalFixture(); f.throughWire(); f.observe({ transaction: { ...f.f.status, outcome: "failure", errorCode: "InstructionError" } });
  assert.equal(f.summary().observationClaims[0]!.classification, "finalized_failure_claim");
  f.observe({ accounts: { kind: "mismatched", reason: "wrong_account_state" } });
  assert.equal(f.summary().observationClaims[1]!.accountClaim, "mismatched"); denied(f.summary());
});
test("replayed observation source event is rejected independently of journal event ID", () => {
  const f = journalFixture(); f.throughWire(); const payload = { observation: f.f.observation, evidenceRef: "ref" };
  f.push("observation", payload); rejects(() => f.push("observation", payload), "replayed_observation");
});
test("matching observation without a local send marker blocks any later first-send reservation", () => {
  const f = journalFixture(); f.throughWire(); f.observe();
  assert.equal(f.summary().firstSendReservedClaim, false); rejects(() => f.reserve(), "admissions_blocked");
});
for (const change of ["reorder", "digest", "projection", "epoch", "head", "identity", "preparation", "evidence"]) test("changed history " + change + " fails replay", () => {
  const f = journalFixture(); f.throughWire(); const model: any = structuredClone(f.model()), evidence: any = structuredClone(f.evidence);
  if (change === "reorder") [model.events[1], model.events[2]] = [model.events[2], model.events[1]];
  if (change === "digest") model.events[1].digest = "aa".repeat(32);
  if (change === "projection") model.events[1].projection.state = "rejected_claim";
  if (change === "epoch") model.events[1].epoch = "2";
  if (change === "head") model.headDigest = "aa".repeat(32);
  if (change === "identity") model.context.anchor.jobIdentity = "aa".repeat(32);
  if (change === "preparation") model.context.preparationIdentity = "aa".repeat(32);
  if (change === "evidence") evidence[0].payload.operatorApprovalRef = "different";
  rejects(() => replayJournalModel(model, evidence));
});
test("lost detached evidence fails closed rather than trusting stored signature labels", () => {
  const f = journalFixture(); f.throughWire(); rejects(() => replayJournalModel(f.model(), []), "missing_detached_evidence");
});
test("serialization revalidates claims but cannot restore policy authority", () => {
  const f = journalFixture(); f.throughWire(); f.reserve(); const model = JSON.parse(JSON.stringify(f.model())), evidence = JSON.parse(JSON.stringify(f.evidence));
  const s = replayJournalModel(model, evidence); assert.deepEqual(s, f.summary());
  assert.throws(() => takeOfflinePolicyMessage(model)); assert.throws(() => takeOfflinePolicyMessage(s)); denied(s);
});
test("fake authority flags on a serialized model reject", () => {
  const f = journalFixture(); rejects(() => replayJournalModel({ ...f.model(), submissionAuthorized: true }, []), "authority_promotion");
});
test("accessors and injected exception codes cannot disclose data through model errors", () => {
  const f = journalFixture(); let calls = 0;
  Object.defineProperty(f.context, "initialSnapshot", { enumerable: true, get() { calls++; return f.f.snapshot; } });
  rejects(() => proposeJournalModel(f.context, "accessor")); assert.equal(calls, 0);
  const secret = "synthetic_private_detail_not_a_credential";
  const proxy = new Proxy({}, { ownKeys() { throw new JournalModelError(secret); } });
  rejects(() => proposeJournalModel(proxy, "proxy"), "invalid_journal_evidence");
});
test("schema-v5 stores are neither migrated nor used as operational model persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "pow-journal-v5-")), path = join(dir, "ledger.sqlite"), store = new LifecycleStore(path);
  try { const f = journalFixture(); f.throughWire(); denied(f.summary());
    const db = new DatabaseSync(path, { readOnly: true }); try { assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 7);
      assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_jobs").get()!.n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'operational_%'").get()!.n, 0);
    } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("model performs no network effects or implicit retries", () => {
  const previous = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw Error("forbidden_network"); };
  try { const f = journalFixture(); f.throughWire(); f.reserve(); denied(f.summary()); denied(f.summary()); assert.equal(calls, 0); }
  finally { globalThis.fetch = previous; }
});
test("bounded model history exhausts closed without pruning or reservation release", () => {
  const f = journalFixture(); for (let n = 1; n < JOURNAL_MODEL_MAX_EVENTS; n++) f.push("reconciliation_required", { reason: "retain_uncertainty" });
  rejects(() => f.push("reconciliation_required", { reason: "overflow" }), "journal_capacity_exhausted");
  assert.equal(f.model().events.length, JOURNAL_MODEL_MAX_EVENTS); denied(f.summary());
});
const windows = ["before_admission", "after_proposal", "after_role_admission", "before_signing", "after_first_signature", "after_both_signatures",
  "before_reservation", "after_reservation", "during_possible_submission", "after_possible_submission", "before_ack", "after_ack",
  "during_observation", "after_conflicting_observations", "during_shutdown", "after_restart"];
for (const [n, window] of windows.entries()) test("MODEL interruption prefix " + window + " retains claims without granting recovery authority", () => {
  const f = journalFixture(); const snapshots: { model: unknown; evidence: unknown }[] = [{ model: f.model(), evidence: [] }];
  const save = () => snapshots.push(structuredClone({ model: f.model(), evidence: f.evidence }));
  f.admit(); save(); f.role(0); save(); f.sign(0); save(); f.role(1); save(); f.sign(1); save(); f.wire(); save(); f.reserve(); save();
  f.push("submission_outcome", { outcome: f.submission("intent_recorded") }); save();
  f.push("submission_outcome", { outcome: f.submission("invocation_potentially_occurred") }); save();
  f.push("submission_outcome", { outcome: f.submission("submission_uncertain", "missing_ack") }); save();
  f.push("submission_outcome", { outcome: f.submission("acknowledgment_received") }); save(); f.observe(); save();
  f.observe({ transaction: { kind: "conflict", left: f.f.status, right: { ...f.f.status, outcome: "failure", errorCode: "InstructionError" } } }); save();
  f.push("shutdown", { operatorApprovalRef: f.f.anchor.operatorApprovalRef }, { currentEpoch: "2", blockHeight: "150" }); save();
  f.push("recovery_requirement", { operatorApprovalRef: f.f.anchor.operatorApprovalRef, reason: "human_recovery_required" }); save();
  const prefixIndex = [0, 0, 2, 2, 3, 5, 6, 7, 9, 9, 10, 11, 12, 13, 14, 15][n]!;
  const prefix = snapshots[prefixIndex]!, serialized = JSON.parse(JSON.stringify(prefix));
  const s = replayJournalModel(serialized.model, serialized.evidence); denied(s);
  assert.deepEqual(replayJournalModel(serialized.model, serialized.evidence), s);
  if (s.firstSendReservedClaim) rejects(() => appendJournalModel(serialized.model, serialized.evidence,
    { kind: "first_send_intent", eventId: "restart_send", payload: { snapshot: f.f.snapshot,
      submissionDigest: protocolDataDigest(f.f.submission), submissionApprovalRef: f.f.anchor.submissionApprovalRef } }));
});
