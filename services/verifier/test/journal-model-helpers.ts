/** Existing PUBLIC signature fixtures only; no signer, key generation or transport. */
import { protocolFixture } from "./protocol-helpers.js";
import { protocolDataDigest, PROTOCOL_VERSION, type SigningOutcome } from "../src/operational-protocol.js";
import { proposeJournalModel, appendJournalModel, replayJournalModel, type JournalEvidence,
  type JournalContext, type JournalEventKind } from "../src/operational-journal-model.js";
export function journalFixture() {
  const f = protocolFixture();
  const context: JournalContext = { anchor: f.anchor, admission: f.admission, initialSnapshot: f.snapshot,
    preparationIdentity: protocolDataDigest(["synthetic_public_preparation", f.anchor.intentIdentity, f.anchor.messageDigest]) };
  let journal = proposeJournalModel(context, "proposal"), snapshot = { ...f.snapshot }, sequence = 0;
  const evidence: JournalEvidence[] = [];
  const push = (kind: JournalEventKind, fields: Record<string, unknown>, patch: Record<string, unknown> = {}) => {
    const payload = structuredClone({ snapshot: { ...snapshot, ...patch }, ...fields }), eventId = "event_" + sequence++;
    const next = appendJournalModel(journal, evidence, { kind, eventId, payload });
    journal = next; snapshot = (payload as any).snapshot; evidence.push({ eventId, payload }); return next;
  };
  const accepted = (n: number): SigningOutcome => {
    const { signatureBase64: _signature, ...old } = f.outcomes[n] as Extract<SigningOutcome, { state: "signature_observed" }>;
    return { ...old, state: "admission_accepted" };
  };
  const admit = () => push("admission_outcome", { state: "accepted_claim", operatorApprovalRef: f.anchor.operatorApprovalRef });
  const role = (n: number) => push("role_admission", { request: f.roles[n], outcome: accepted(n) });
  const sign = (n: number) => push("signing_outcome", { request: f.roles[n], outcome: f.outcomes[n] });
  const wire = () => push("wire_reference", { submission: f.submission, roles: f.roles, outcomes: f.outcomes, protectedRef: "test_protected_reference" });
  const reserve = () => push("first_send_intent", { submissionDigest: protocolDataDigest(f.submission), submissionApprovalRef: f.anchor.submissionApprovalRef });
  const throughWire = () => { admit(); role(0); sign(0); role(1); sign(1); wire(); };
  const submission = (state: string, reason: string | null = null) => ({ version: PROTOCOL_VERSION, kind: "offline_submission_outcome", state,
    senderAdmissionId: f.submission.senderAdmissionId, submissionDigest: protocolDataDigest(f.submission), transactionId: f.submission.transactionId,
    acknowledgmentTransactionId: state === "acknowledgment_received" ? f.submission.transactionId : null, reason });
  const observe = (patch: Record<string, unknown> = {}) => {
    const observation = structuredClone(f.observation); Object.assign(observation.provenance, { eventId: "source_" + sequence });
    Object.assign(observation, patch); return push("observation", { observation, evidenceRef: "test_observation_reference" }, { blockHeight: "150" });
  };
  return { f, context, evidence, push, accepted, admit, role, sign, wire, reserve, throughWire, submission, observe,
    model: () => journal, summary: () => replayJournalModel(journal, evidence) };
}
