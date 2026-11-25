/** Public pre-existing wire/signatures only. No key generation, signing or external callbacks. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { LifecycleStore } from "@proofwork/lifecycle";
import { ledgerFixture, mutateBytes } from "./read-only-helpers.js";
import { protocolDataDigest, PROTOCOL_VERSION } from "../src/operational-protocol.js";
import { reviewDevnetExecutionReadiness, type DevnetReadinessResult } from "../src/devnet-execution-readiness.js";
import { takeOfflinePolicyMessage } from "../src/transaction-policy.js";
import { OfflineReadError } from "../src/read-only-observation-data.js";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pow-readiness-")), path = join(dir, "ledger.sqlite"), f = ledgerFixture(path);
  t.after(() => { f.s.close(); rmSync(dir, { recursive: true, force: true }); });
  const roles = f.f.roles.map(r => ({ ...r, admissionDigest: protocolDataDigest(f.plan.admission) }));
  const outcomes = f.f.outcomes.map((s, n) => ({ ...s, requestDigest: protocolDataDigest(roles[n]) }));
  const request = { mode: "offline-review", plan: f.plan, roleRequests: roles, signingOutcomes: outcomes,
    submissionOutcome: null as unknown, bundles: [f.bundle] };
  const review = () => reviewDevnetExecutionReadiness(f.s, request);
  const outcome = (state: string, reason: string | null = null) => ({ version: PROTOCOL_VERSION, kind: "offline_submission_outcome", state,
    senderAdmissionId: f.plan.submission.senderAdmissionId, submissionDigest: protocolDataDigest(f.plan.submission),
    transactionId: f.plan.submission.transactionId, acknowledgmentTransactionId: state === "acknowledgment_received" ? f.plan.submission.transactionId : null, reason });
  return { ...f, path, request, roles, outcomes, review, outcome };
}
function disabled(r: DevnetReadinessResult) {
  assert.equal(r.readiness, "NOT_READY"); assert.equal(r.signingAuthorization, "not_granted");
  for (const k of ["operationalAuthorization", "submissionAuthorized", "retryAuthorized", "reservationReleaseAuthorized",
    "rpcAuthenticated", "onChainStateVerified", "operationalStateMutationAuthorized"] as const) assert.equal(r[k], false, k);
  assert.equal(r.reconciliationRequired, true); assert.equal(r.blockers.length, 13); assert(Object.isFrozen(r.comparisons));
  for (const field of ["messageBase64", "wireBase64", "signatureBase64", "payerApprovalRef", "operatorApprovalRef"])
    assert(!JSON.stringify(r).includes(field), field);
}
test("real v5 history, both role signatures, full wire and raw post-state are correlated without activation", t => {
  const f = setup(t), before = f.snapshot(), r = f.review(); disabled(r);
  assert.equal(r.code, "operational_controls_unavailable"); assert.equal(r.attemptId, f.attempt.attemptId);
  assert.deepEqual(r.comparisons, { localHistoryCorrelated: true, currentWorkerFenceMatches: true,
    freshAdmissionDataConsistent: true, roleStates: ["signature_observed", "signature_observed"], completeWireRoleCorrelation: true,
    reportedSubmissionState: null, observationClassification: "matching_finalized_candidate" });
  assert.deepEqual(f.snapshot(), before);
});
for (const field of ["authenticated", "approved", "enabled", "custodyProvider", "privateKey", "sendTransaction", "rpc", "externalEpoch", "shutdown"]) {
  test("caller cannot inject activation/control field " + field, t => {
    const f = setup(t), before = f.snapshot(), r = reviewDevnetExecutionReadiness(f.s, { ...f.request, [field]: true });
    assert.equal(r.code, "invalid_readiness_request"); assert.deepEqual(f.snapshot(), before); disabled(r);
  });
}
test("request accessors are rejected without executing them", t => {
  const f = setup(t); let calls = 0;
  Object.defineProperty(f.request, "plan", { enumerable: true, get() { calls++; return f.plan; } });
  assert.equal(f.review().code, "invalid_readiness_request"); assert.equal(calls, 0);
});
for (const field of ["cluster", "genesisHash", "programId", "verifier"]) test("wrong approved binding " + field + " rejects", t => {
  const f = setup(t); (f.plan.anchor.bindings as any)[field] = field === "cluster" ? "unsupported" : f.plan.anchor.feePayer;
  const r = f.review(); assert.notEqual(r.code, "operational_controls_unavailable"); disabled(r);
});
test("changed fee payer rejects", t => {
  const f = setup(t); (f.plan.anchor as any).feePayer = f.plan.anchor.bindings.verifier;
  const r = f.review(); assert.notEqual(r.code, "operational_controls_unavailable"); disabled(r);
});
test("changed canonical message rejects even with a recomputed digest", t => {
  const f = setup(t), b = Buffer.from(f.plan.admission.messageBase64, "base64"); b[b.length - 1] = b[b.length - 1]! ^ 1;
  (f.plan.admission as any).messageBase64 = b.toString("base64");
  const digest = createHash("sha256").update(b).digest("hex");
  (f.plan.admission as any).messageDigest = digest; (f.plan.anchor as any).messageDigest = digest;
  const r = f.review(); assert.notEqual(r.code, "operational_controls_unavailable"); disabled(r);
});
for (const role of [0, 1]) test("invalid signature for role " + role + " rejects", t => {
  const f = setup(t); (f.outcomes[role] as any).signatureBase64 = Buffer.alloc(64).toString("base64");
  const r = f.review(); assert.equal(r.code, "invalid_protocol_data"); disabled(r);
});
test("missing payer evidence cannot establish a complete wire-role correlation", t => {
  const f = setup(t); f.request.signingOutcomes.pop(); const r = f.review();
  assert.equal(r.code, "incomplete_role_evidence"); assert.equal(r.comparisons.completeWireRoleCorrelation, false); disabled(r);
});
for (const state of ["not_admitted", "admission_accepted", "signing_rejected", "signing_uncertain"]) test("reported custody state " + state + " retains signing uncertainty", t => {
  const f = setup(t), previous: any = f.outcomes[0], { signatureBase64: _signature, receiptRef: _receipt, ...base } = previous;
  f.request.signingOutcomes[0] = { ...base, state,
    ...(state === "admission_accepted" ? { receiptRef: "fixture_receipt" } : state === "signing_uncertain"
      ? { receiptRef: null, reason: "fixture_interruption" } : { reason: "fixture_interruption" }) } as any;
  const r = f.review(); assert.equal(r.code, "incomplete_signing_evidence"); assert.equal(r.comparisons.completeWireRoleCorrelation, false);
  assert.equal(r.comparisons.roleStates[0], state); disabled(r);
});
for (const field of ["operatorApprovalRef", "payerApprovalRef", "verifierApprovalRef", "submissionApprovalRef"]) {
  test("self-consistent invented " + field + " remains untrusted comparison data", t => {
    const f = setup(t); (f.plan.anchor as any)[field] = "invented_fixture_reference";
    if (field === "operatorApprovalRef") (f.plan.admission as any)[field] = "invented_fixture_reference";
    if (field === "submissionApprovalRef") (f.plan.submission as any)[field] = "invented_fixture_reference";
    f.roles.forEach((r, n) => { r.admissionDigest = protocolDataDigest(f.plan.admission);
      if (field === (n === 0 ? "verifierApprovalRef" : "payerApprovalRef")) r.roleApprovalRef = "invented_fixture_reference";
      (f.outcomes[n] as any).requestDigest = protocolDataDigest(r); });
    (f.plan.submission as any).admissionDigest = protocolDataDigest(f.plan.admission);
    const r = f.review(); assert.equal(r.code, "operational_controls_unavailable"); disabled(r);
  });
}
for (const patch of [{ nowUnixMs: "2000" }, { blockHeight: "201" }, { currentEpoch: "2" }]) {
  test("expired/revoked comparison " + Object.keys(patch)[0] + " never refreshes the original admission", t => {
    const f = setup(t); Object.assign(f.plan.snapshot, patch); const r = f.review();
    assert.equal(r.code, "fresh_comparison_failed"); assert.equal(r.comparisons.freshAdmissionDataConsistent, false);
    assert.equal(r.comparisons.completeWireRoleCorrelation, false); disabled(r);
  });
}
test("self-consistent forged epoch does not authenticate an external fence", t => {
  const f = setup(t); (f.plan.snapshot as any).currentEpoch = "999"; (f.plan.anchor as any).epoch = "999";
  (f.plan.admission as any).epoch = "999"; (f.plan.submission as any).epoch = "999";
  f.roles.forEach((r, n) => { r.epoch = "999"; r.admissionDigest = protocolDataDigest(f.plan.admission);
    (f.outcomes[n] as any).requestDigest = protocolDataDigest(r); });
  (f.plan.submission as any).admissionDigest = protocolDataDigest(f.plan.admission);
  const r = f.review(); assert.equal(r.comparisons.freshAdmissionDataConsistent, true);
  assert(r.blockers.includes("external_fencing_unavailable")); disabled(r);
});
test("revoked current job cannot appear ready even though immutable intent correlation still matches", t => {
  const f = setup(t); f.s.jobRecovery.interruptJob(f.job.jobId, f.job.identity, f.job.revision, "operator");
  const before = f.snapshot(), r = f.review(); assert.equal(r.code, "stale_worker");
  assert.equal(r.comparisons.observationClassification, "matching_finalized_candidate"); assert.deepEqual(f.snapshot(), before); disabled(r);
});
for (const state of ["not_admitted", "intent_recorded", "invocation_potentially_occurred", "acknowledgment_received", "submission_uncertain"]) {
  test("submission claim " + state + " is not a durable first-send reservation or permission to retry", t => {
    const f = setup(t); f.request.submissionOutcome = f.outcome(state, ["not_admitted", "submission_uncertain"].includes(state) ? "fixture_timeout" : null);
    const before = f.snapshot(), r = f.review(); assert.equal(r.comparisons.reportedSubmissionState, state);
    assert(r.blockers.includes("first_submission_reservation_unavailable")); assert.deepEqual(f.snapshot(), before); disabled(r);
  });
}
test("wrong acknowledgment transaction identity rejects", t => {
  const f = setup(t), o = f.outcome("acknowledgment_received"); o.acknowledgmentTransactionId = f.plan.anchor.feePayer;
  f.request.submissionOutcome = o; assert.equal(f.review().code, "invalid_protocol_data");
});
for (const interruption of ["before_read", "status_timeout", "status_exception"] as const) test("read interruption " + interruption + " retains unknown outcome", t => {
  const f = setup(t); Object.assign(f.bundle, { status: null, transaction: null, accounts: null, interruption });
  const r = f.review(); assert.equal(r.comparisons.observationClassification, "missing_evidence"); disabled(r);
});
test("finalized transaction failure never becomes success from matching accounts", t => {
  const f = setup(t); Object.assign((f.bundle.status as any).evidence, { outcome: "failure", errorCode: "InstructionError" });
  Object.assign(f.bundle.transaction as any, { outcome: "failure", errorCode: "InstructionError" });
  const r = f.review(); assert.equal(r.comparisons.observationClassification, "finalized_failure"); disabled(r);
});
test("success with wrong raw account state stays mismatched", t => {
  const f = setup(t); mutateBytes(f.accounts, "milestone", b => { b[272] = 6; });
  const r = f.review(); assert.equal(r.comparisons.observationClassification, "account_state_mismatch"); disabled(r);
});
test("contradictory RPC fixture observations are retained as conflict", t => {
  const f = setup(t); Object.assign(f.bundle.transaction as any, { outcome: "failure", errorCode: "InstructionError" });
  const r = f.review(); assert.equal(r.comparisons.observationClassification, "conflicting_evidence"); disabled(r);
});
test("matching fixture and existing program ID cannot prove a deployed program or authorized DEMO setup", t => {
  const f = setup(t), r = f.review(); assert.equal(r.comparisons.observationClassification, "matching_finalized_candidate");
  assert(r.blockers.includes("verified_deployment_unavailable")); assert(r.blockers.includes("demo_setup_not_authorized")); disabled(r);
});
test("replayed review and duplicate operation never create operational admission", t => {
  const f = setup(t), before = f.snapshot(); assert.deepEqual(f.review(), f.review());
  const duplicate = f.s.jobs.createOrGetJob("duplicate_review", f.job.bindings);
  assert.equal(duplicate.jobId, f.job.jobId); assert.deepEqual(f.snapshot(), before); disabled(f.review());
});
test("restart, partial history and original v4 reconciliation hold remain non-operational", t => {
  const f = setup(t), i = f.s.transactionIntents.getIntent(f.attempt.intent.intentId)!;
  f.s.transactionIntents.requireReconciliation(f.claim, f.job.revision, i.intentId, i.identity, i.revision);
  const before = f.snapshot(), reopened = new LifecycleStore(f.path);
  try { const r = reviewDevnetExecutionReadiness(reopened, f.request); assert.equal(r.code, "operational_controls_unavailable");
    assert.deepEqual(f.snapshot(), before); disabled(r);
  } finally { reopened.close(); }
  const db = new DatabaseSync(f.path, { readOnly: true }); try {
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 7);
    assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
  } finally { db.close(); }
});
test("missing and stale attempts cannot be replaced with caller metadata", t => {
  const f = setup(t); (f.plan.attempt as any).attemptId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.equal(f.review().code, "missing_execution_history");
  (f.plan.attempt as any).attemptId = f.attempt.attemptId; (f.plan.attempt as any).revision = 1;
  assert.equal(f.review().code, "stale_execution_revision");
});
test("corrupt ledger history fails closed", t => {
  const f = setup(t), db = new DatabaseSync(f.path);
  db.exec("DROP TRIGGER execution_history_no_update; UPDATE execution_history SET digest='corrupt' WHERE revision=0"); db.close();
  const r = f.review(); assert.equal(r.code, "invalid_local_history"); disabled(r);
});
test("readiness results and serialized copies cannot restore genuine policy provenance", t => {
  const f = setup(t), r = f.review(); assert.throws(() => takeOfflinePolicyMessage(r));
  assert.throws(() => takeOfflinePolicyMessage(structuredClone(r))); disabled(r);
});
test("no fetch, key loader, signature provider, send callback or hidden retry is invoked", t => {
  const f = setup(t), previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("forbidden_network"); };
  try { const before = f.snapshot(); for (let n = 0; n < 3; n++) disabled(f.review());
    assert.equal(calls, 0); assert.deepEqual(f.snapshot(), before);
  } finally { globalThis.fetch = previous; }
});
for (const typed of [false, true]) test("dependency " + (typed ? "code" : "message") + " is never disclosed", t => {
  const f = setup(t), secret = "synthetic_dependency_secret_not_a_credential";
  Object.defineProperty(f.s, "executionAttempts", { get() { throw typed ? new OfflineReadError(secret) : Error(secret); } });
  const r = f.review(); assert.equal(r.code, typed ? "invalid_readiness_data" : "readiness_dependency_failure");
  assert(!JSON.stringify(r).includes(secret)); disabled(r);
});
