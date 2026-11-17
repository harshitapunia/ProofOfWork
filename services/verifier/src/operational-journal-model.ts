/** Pure append/replay MODEL. No persistence, signer, sender, trusted token or RPC. */
import { validateAdmission, validateHistoricalAdmission, validateRoleRequest, validateSigningOutcome,
  validateSubmission, validateSubmissionOutcome, validateObservation, classifyObservation, protocolDataDigest,
  type ProtocolAnchor, type ProtocolSnapshot, type AdmissionRequest, type CustodyRoleRequest,
  type SigningOutcome, type SubmissionRequest, type SubmissionOutcome, type StatusClaim } from "./operational-protocol.js";
import { record, list, freeze } from "./read-only-observation-data.js";

export const JOURNAL_MODEL_VERSION = "proofwork-journal-model-v1" as const;
export const JOURNAL_MODEL_MAX_EVENTS = 128;
const denied = Object.freeze({ operationalAuthorization: false as const, signingAuthorization: "not_granted" as const,
  submissionAuthorized: false as const, retryAuthorized: false as const, reservationReleaseAuthorized: false as const,
  rpcAuthenticated: false as const, onChainStateVerified: false as const, operationalStateMutationAuthorized: false as const,
  reconciliationRequired: true as const });
export class JournalModelError extends Error { constructor(public readonly code: string) { super(code); } }
const errors = new Set(["invalid_journal_model", "invalid_journal_evidence", "comparison_policy_changed", "comparison_regression",
  "stale_epoch", "admissions_blocked", "duplicate_admission", "missing_admission_intent", "duplicate_admission_outcome",
  "replayed_role_admission", "signature_before_role_admission", "replayed_signing_outcome", "role_request_changed",
  "duplicate_wire_reference", "incomplete_role_signatures", "role_evidence_changed", "missing_signed_wire_reference",
  "duplicate_first_send_reservation", "missing_first_send_reservation", "replayed_submission_outcome", "submission_order_conflict",
  "replayed_observation", "authority_promotion", "missing_detached_evidence", "event_order_or_replay", "changed_journal_history",
  "changed_journal_head", "journal_capacity_exhausted", "duplicate_admission_identity", "duplicate_permanent_operation"]);
function check(value: unknown, code = "invalid_journal_model"): asserts value { if (!value) throw new JournalModelError(code); }
function reference(value: unknown): asserts value is string { check(typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)); }
function digest(value: unknown): asserts value is string { check(typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && /[1-9a-f]/.test(value)); }
function safe<T>(fn: () => T): T { try { return fn(); } catch (e) { if (e instanceof JournalModelError && errors.has(e.code)) throw e; throw new JournalModelError("invalid_journal_evidence"); } }
export interface JournalContext {
  readonly anchor: ProtocolAnchor; readonly admission: AdmissionRequest;
  readonly preparationIdentity: string; readonly initialSnapshot: ProtocolSnapshot;
}
export type JournalEventKind = "admission_intent" | "admission_outcome" | "role_admission" | "signing_outcome"
  | "wire_reference" | "first_send_intent" | "submission_outcome" | "observation" | "reconciliation_required" | "shutdown" | "recovery_requirement";
export interface JournalEvent {
  readonly revision: number; readonly eventId: string; readonly kind: JournalEventKind; readonly epoch: string;
  readonly evidenceDigest: string; readonly projection: Readonly<Record<string, string | boolean | null>>;
  readonly previousDigest: string; readonly digest: string;
}
/** Payloads are transient validation inputs. Do not log/persist this sidecar as general audit data. */
export interface JournalEvidence { readonly eventId: string; readonly payload: unknown }
export interface JournalModel extends Readonly<typeof denied> {
  readonly kind: "operational_journal_model"; readonly version: typeof JOURNAL_MODEL_VERSION;
  readonly context: JournalContext; readonly events: readonly JournalEvent[]; readonly headDigest: string;
}
export interface JournalSummary extends Readonly<typeof denied> {
  readonly kind: "journal_model_projection"; readonly operationKey: string; readonly admissionId: string;
  readonly admissionState: "proposed" | "accepted_claim" | "rejected_claim" | "uncertain_claim";
  readonly roleClaims: readonly Readonly<Record<string, string | boolean | null>>[];
  readonly wireReferenceDigest: string | null; readonly firstSendReservedClaim: boolean;
  readonly submissionStates: readonly SubmissionOutcome["state"][];
  readonly observationClaims: readonly Readonly<Record<string, string | boolean | null>>[];
  readonly epoch: string; readonly shutdownClaim: boolean; readonly ambiguityRetained: boolean;
  readonly conflictingClaimsRetained: boolean; readonly furtherAdmissionsBlocked: boolean; readonly headDigest: string;
}
interface RoleData { request: CustodyRoleRequest; admission: SigningOutcome; outcome?: SigningOutcome }
interface State {
  context: JournalContext; admission: JournalSummary["admissionState"]; epoch: string; snapshot: ProtocolSnapshot;
  roles: Map<string, RoleData>; consumed: Set<string>; wire: SubmissionRequest | null;
  wireEvidence: { roles: CustodyRoleRequest[]; outcomes: SigningOutcome[] } | null; wireReferenceDigest: string | null;
  reserved: boolean; submissionStates: SubmissionOutcome["state"][]; stopped: boolean; blocked: boolean; ambiguous: boolean;
  observations: Record<string, string | boolean | null>[]; facts: StatusClaim[]; conflict: boolean;
}
function context(input: unknown): JournalContext {
  protocolDataDigest(input);
  const c = record(input, ["anchor", "admission", "preparationIdentity", "initialSnapshot"]);
  digest(c.preparationIdentity);
  const admission = validateHistoricalAdmission(c.admission, c.anchor, c.initialSnapshot).data;
  return freeze(structuredClone({ ...c, admission }) as unknown as JournalContext);
}
function initial(c: JournalContext): State {
  return { context: c, admission: "proposed", epoch: c.anchor.epoch, snapshot: c.initialSnapshot, roles: new Map(), consumed: new Set(),
    wire: null, wireEvidence: null, wireReferenceDigest: null, reserved: false, submissionStates: [], stopped: false,
    blocked: false, ambiguous: false, observations: [], facts: [], conflict: false };
}
function snapshot(s: State, input: unknown, control: boolean): ProtocolSnapshot {
  validateHistoricalAdmission(s.context.admission, s.context.anchor, input);
  const value = structuredClone(input) as ProtocolSnapshot;
  check(value.minRemainingBlockHeights === s.context.initialSnapshot.minRemainingBlockHeights
    && protocolDataDigest(value.sourceIds) === protocolDataDigest(s.context.initialSnapshot.sourceIds), "comparison_policy_changed");
  check(BigInt(value.nowUnixMs) >= BigInt(s.snapshot.nowUnixMs) && BigInt(value.blockHeight) >= BigInt(s.snapshot.blockHeight), "comparison_regression");
  check(control ? BigInt(value.currentEpoch) > BigInt(s.epoch) : value.currentEpoch === s.epoch, "stale_epoch");
  s.snapshot = freeze(value); return s.snapshot;
}
function freshAction(s: State, snap: ProtocolSnapshot): void {
  check(s.admission === "accepted_claim" && !s.stopped && !s.blocked, "admissions_blocked");
  check(s.epoch === s.context.anchor.epoch, "stale_epoch");
  validateAdmission(s.context.admission, s.context.anchor, snap);
}
function apply(s: State, kind: JournalEventKind, payload: unknown, first: boolean): Record<string, string | boolean | null> {
  const c = s.context;
  protocolDataDigest(payload);
  const keys: Record<JournalEventKind, string[]> = {
    admission_intent: ["snapshot"], admission_outcome: ["snapshot", "state", "operatorApprovalRef"],
    role_admission: ["snapshot", "request", "outcome"], signing_outcome: ["snapshot", "request", "outcome"],
    wire_reference: ["snapshot", "submission", "roles", "outcomes", "protectedRef"],
    first_send_intent: ["snapshot", "submissionDigest", "submissionApprovalRef"],
    submission_outcome: ["snapshot", "outcome"], observation: ["snapshot", "observation", "evidenceRef"],
    reconciliation_required: ["snapshot", "reason"], shutdown: ["snapshot", "operatorApprovalRef"],
    recovery_requirement: ["snapshot", "operatorApprovalRef", "reason"],
  };
  check(Object.hasOwn(keys, kind));
  const p = record(payload, keys[kind]), snap = snapshot(s, p.snapshot, kind === "shutdown");
  if (kind === "admission_intent") {
    check(first, "duplicate_admission"); validateAdmission(c.admission, c.anchor, snap);
    return { state: "proposed", admissionId: c.admission.admissionId };
  }
  check(!first, "missing_admission_intent");
  if (kind === "admission_outcome") {
    check(s.admission === "proposed" && !s.stopped && !s.blocked, "duplicate_admission_outcome");
    check(p.operatorApprovalRef === c.anchor.operatorApprovalRef);
    check(["accepted_claim", "rejected_claim", "uncertain_claim"].includes(p.state));
    if (p.state === "accepted_claim") validateAdmission(c.admission, c.anchor, snap);
    s.admission = p.state; if (p.state !== "accepted_claim") s.blocked = true;
    if (p.state === "uncertain_claim") s.ambiguous = true;
    return { state: p.state, approvalReferenceDigest: protocolDataDigest(p.operatorApprovalRef) };
  }
  if (kind === "role_admission" || kind === "signing_outcome") {
    const outcome = validateSigningOutcome(p.outcome, p.request, c.admission, c.anchor, snap).data;
    const role = outcome.role, old = s.roles.get(role);
    if (kind === "role_admission") {
      freshAction(s, snap);
      const request = validateRoleRequest(p.request, c.admission, c.anchor, snap).data;
      check(!old && !s.consumed.has(request.requestId), "replayed_role_admission");
      check(outcome.state !== "signature_observed", "signature_before_role_admission");
      s.roles.set(role, { request, admission: outcome }); s.consumed.add(request.requestId);
    } else {
      check(old && old.admission.state === "admission_accepted" && !old.outcome, "replayed_signing_outcome");
      check(protocolDataDigest(old.request) === protocolDataDigest(p.request), "role_request_changed");
      check(["signature_observed", "signing_rejected", "signing_uncertain"].includes(outcome.state));
      old.outcome = outcome;
    }
    if (["not_admitted", "signing_rejected", "signing_uncertain"].includes(outcome.state)) s.blocked = true;
    if (outcome.state === "signing_uncertain") s.ambiguous = true;
    return { role, state: outcome.state, requestId: outcome.requestId, requestDigest: outcome.requestDigest,
      publicKey: outcome.publicKey, messageDigest: outcome.messageDigest };
  }
  if (kind === "wire_reference") {
    freshAction(s, snap); check(!s.wire, "duplicate_wire_reference"); reference(p.protectedRef);
    const roles = list(p.roles, 2), outcomes = list(p.outcomes, 2);
    check(roles.length === 2 && outcomes.length === 2);
    for (const [n, role] of (["verifier", "fee_payer"] as const).entries()) {
      const old = s.roles.get(role); check(old?.outcome?.state === "signature_observed", "incomplete_role_signatures");
      check(protocolDataDigest(old.request) === protocolDataDigest(roles[n])
        && protocolDataDigest(old.outcome) === protocolDataDigest(outcomes[n]), "role_evidence_changed");
    }
    s.wire = validateSubmission(p.submission, c.admission, roles, outcomes, c.anchor, snap).data;
    s.wireEvidence = { roles: structuredClone(roles) as CustodyRoleRequest[], outcomes: structuredClone(outcomes) as SigningOutcome[] };
    s.wireReferenceDigest = protocolDataDigest(p.protectedRef);
    return { referenceDigest: s.wireReferenceDigest, wireDigest: s.wire.wireDigest, transactionId: s.wire.transactionId };
  }
  if (kind === "first_send_intent") {
    freshAction(s, snap); check(s.wire && s.wireEvidence, "missing_signed_wire_reference");
    check(!s.reserved, "duplicate_first_send_reservation");
    check(p.submissionDigest === protocolDataDigest(s.wire) && p.submissionApprovalRef === c.anchor.submissionApprovalRef);
    validateSubmission(s.wire, c.admission, s.wireEvidence.roles, s.wireEvidence.outcomes, c.anchor, snap);
    s.reserved = true; return { submissionDigest: p.submissionDigest, state: "intent_recorded" };
  }
  if (kind === "submission_outcome") {
    check(s.reserved && s.wire, "missing_first_send_reservation");
    const value = validateSubmissionOutcome(p.outcome, s.wire, c.admission, c.anchor, snap).data;
    check(!s.submissionStates.includes(value.state), "replayed_submission_outcome");
    check(value.state !== "intent_recorded" || s.submissionStates.length === 0, "submission_order_conflict");
    s.submissionStates.push(value.state);
    if (value.state === "submission_uncertain" || value.state === "not_admitted") { s.blocked = true; s.ambiguous = true; }
    return { state: value.state, transactionId: value.transactionId, acknowledgmentTransactionId: value.acknowledgmentTransactionId };
  }
  if (kind === "observation") {
    check(s.wire, "missing_signed_wire_reference"); reference(p.evidenceRef);
    const v = validateObservation(p.observation, s.wire, c.admission, c.anchor, snap).data;
    const classification = classifyObservation(v, s.wire, c.admission, c.anchor, snap).classification;
    check(!s.observations.some(o => o.sourceId === v.provenance.sourceId && o.sourceEventId === v.provenance.eventId), "replayed_observation");
    const facts = v.transaction.kind === "status_claim" ? [v.transaction] : v.transaction.kind === "conflict" ? [v.transaction.left, v.transaction.right] : [];
    for (const fact of facts) {
      if (s.facts.some(old => old.outcome !== fact.outcome || old.errorCode !== fact.errorCode || old.transactionSlot !== fact.transactionSlot)) s.conflict = true;
      s.facts.push(fact);
    }
    if (classification === "conflicting_evidence") s.conflict = true;
    if (classification === "missing_evidence" || classification === "finalized_failure_claim"
      || v.accounts.kind === "mismatched" || s.conflict) { s.ambiguous = true; s.blocked = true; }
    // Observation can expose a missing local send marker; it never permits a later first send.
    s.blocked = true;
    const projection = { classification, accountClaim: v.accounts.kind, sourceId: v.provenance.sourceId,
      sourceEventId: v.provenance.eventId, provenance: v.provenance.kind, evidenceReferenceDigest: protocolDataDigest(p.evidenceRef) };
    s.observations.push(projection); return projection;
  }
  if (kind === "shutdown" || kind === "recovery_requirement") {
    check(p.operatorApprovalRef === c.anchor.operatorApprovalRef);
    if (kind === "shutdown") { s.epoch = snap.currentEpoch; s.stopped = true; }
    else reference(p.reason);
    s.blocked = true; s.ambiguous = true;
    return { shutdownClaim: s.stopped, recoveryRequired: true, approvalReferenceDigest: protocolDataDigest(p.operatorApprovalRef) };
  }
  check(kind === "reconciliation_required"); reference(p.reason); s.blocked = true; s.ambiguous = true;
  return { reason: p.reason };
}
function event(s: State, previous: string, revision: number, eventId: unknown, kind: unknown, payload: unknown): JournalEvent {
  reference(eventId); check(typeof kind === "string");
  const projection = apply(s, kind as JournalEventKind, payload, revision === 0);
  const data = { revision, eventId, kind: kind as JournalEventKind, epoch: s.epoch,
    evidenceDigest: protocolDataDigest(payload), projection, previousDigest: previous };
  return freeze({ ...data, digest: protocolDataDigest([JOURNAL_MODEL_VERSION, data]) });
}
function journal(c: JournalContext, events: readonly JournalEvent[]): JournalModel {
  return freeze({ kind: "operational_journal_model", version: JOURNAL_MODEL_VERSION, context: c,
    events: [...events], headDigest: events[events.length - 1]!.digest, ...denied });
}
function replay(input: unknown, sidecar: unknown): { model: JournalModel; state: State } {
  const m = record(input, ["kind", "version", "context", "events", "headDigest", ...Object.keys(denied)]);
  check(m.kind === "operational_journal_model" && m.version === JOURNAL_MODEL_VERSION);
  for (const [key, value] of Object.entries(denied)) check(m[key] === value, "authority_promotion");
  const c = context(m.context), s = initial(c), records = list(m.events, JOURNAL_MODEL_MAX_EVENTS), evidence = list(sidecar, JOURNAL_MODEL_MAX_EVENTS);
  check(records.length > 0 && evidence.length === records.length - 1, "missing_detached_evidence");
  const seen = new Set<string>(), events: JournalEvent[] = []; let previous = protocolDataDigest([JOURNAL_MODEL_VERSION, c]);
  for (const [n, raw] of records.entries()) {
    const row = record(raw, ["revision", "eventId", "kind", "epoch", "evidenceDigest", "projection", "previousDigest", "digest"]);
    const detached = n === 0 ? { eventId: row.eventId, payload: { snapshot: c.initialSnapshot } } : record(evidence[n - 1], ["eventId", "payload"]);
    check(row.revision === n && !seen.has(row.eventId) && detached.eventId === row.eventId, "event_order_or_replay");
    check(n !== 0 || row.kind === "admission_intent", "missing_admission_intent");
    const expected = event(s, previous, n, row.eventId, row.kind, detached.payload);
    check(protocolDataDigest(expected) === protocolDataDigest(row), "changed_journal_history");
    seen.add(row.eventId); events.push(expected); previous = expected.digest;
  }
  check(m.headDigest === previous, "changed_journal_head"); return { model: journal(c, events), state: s };
}
export function proposeJournalModel(input: unknown, eventId: string): JournalModel {
  return safe(() => { const c = context(input), s = initial(c);
    return journal(c, [event(s, protocolDataDigest([JOURNAL_MODEL_VERSION, c]), 0, eventId, "admission_intent", { snapshot: c.initialSnapshot })]); });
}
export function appendJournalModel(input: unknown, detachedEvidence: unknown, descriptor: unknown): JournalModel {
  return safe(() => { const { model, state } = replay(input, detachedEvidence), d = record(descriptor, ["eventId", "kind", "payload"]);
    check(model.events.length < JOURNAL_MODEL_MAX_EVENTS, "journal_capacity_exhausted");
    check(!model.events.some(e => e.eventId === d.eventId), "event_order_or_replay");
    const next = event(state, model.headDigest, model.events.length, d.eventId, d.kind, d.payload);
    return journal(model.context, [...model.events, next]); });
}
export function replayJournalModel(input: unknown, detachedEvidence: unknown): JournalSummary {
  return safe(() => { const { model, state: s } = replay(input, detachedEvidence);
    return freeze({ kind: "journal_model_projection", operationKey: model.context.admission.operationKey,
      admissionId: model.context.admission.admissionId, admissionState: s.admission,
      roleClaims: model.events.filter(e => e.kind === "role_admission" || e.kind === "signing_outcome").map(e => e.projection),
      wireReferenceDigest: s.wireReferenceDigest, firstSendReservedClaim: s.reserved, submissionStates: [...s.submissionStates],
      observationClaims: [...s.observations], epoch: s.epoch, shutdownClaim: s.stopped, ambiguityRetained: s.ambiguous,
      conflictingClaimsRetained: s.conflict, furtherAdmissionsBlocked: s.blocked, headDigest: model.headDigest, ...denied }); });
}
/** Uniqueness within the supplied model collection only; omitting history cannot prove global exclusion. */
export function validateJournalCollection(input: unknown): readonly JournalSummary[] {
  return safe(() => { const admissions = new Set<string>(), operations = new Set<string>();
    return freeze(list(input, 32).map(value => { const v = record(value, ["journal", "evidence"]), summary = replayJournalModel(v.journal, v.evidence);
      check(!admissions.has(summary.admissionId), "duplicate_admission_identity");
      check(!operations.has(summary.operationKey), "duplicate_permanent_operation");
      admissions.add(summary.admissionId); operations.add(summary.operationKey); return summary; })); });
}
