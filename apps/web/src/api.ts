import { AUTH_ROUTES } from "./routes";
export { uuid } from "./routes";
/** Browser-only projection of the existing v1 API. No transaction or token capability. */
export const VERSION = "proofwork-application-api-v1";
export const ENVELOPE = { apiVersion: VERSION, cluster: "devnet" } as const;
export interface Health { kind: "health"; readiness: "limited"; authentication: string; applicationReads: string; storage: "not_probed"; chain: "not_probed"; execution: "disabled"|"action_approval_required" }
export interface Session { kind: "wallet_session"; wallet: string; expiresAt: string; origin: string; domain: string; cluster: "devnet"; authenticationMethod: "siws-raw-ed25519" }
export interface Challenge { kind: "wallet_challenge"; wallet: string; challengeId: string; message: string; issuedAt: string; expiresAt: string; signedMessageFormat: "siws-raw-ed25519" }
export interface Job { kind: "verification_job"; jobId: string; milestone: string; state: string; verificationOutcome: "none" | "passed" | "rejected"; reconciliationRequired: boolean }
export interface Milestone { kind: "milestone_state"; address: string; internship: string; sponsor: string; student: string; verifier: string; rewardMint: string; status: string; rewardAmountRaw: string; milestoneId: string; assignBy: string; submitBy: string; submittedAt: string | null; verifiedAt: string | null; settledAt: string | null; slot: number; commitment: string; programDeployment: "not_verified"; rewardPayment: "not_established" }
export interface Execution { kind: "execution_status"; jobId: string; phase: string | null; reconciliationRequired: boolean; operationalExecution: "unavailable"; liveTransactionId: null; rewardPayment: "not_established" }
export interface Observation<T> { data: T; provenance: string }
export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); }
}
export async function request<T>(path: string, kind: string, body?: object, signal?: AbortSignal): Promise<Observation<T>> {
  let response: Response;
  try {
    response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: signal ?? AbortSignal.timeout(12_000), ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  } catch { throw new ApiError("network_unavailable"); }
  let value;
  try { value = await response.json(); } catch { throw new ApiError("api_unavailable", response.status); }
  if (value?.apiVersion !== VERSION || value.cluster !== "devnet") throw new ApiError("invalid_api_response");
  if (!response.ok) throw new ApiError(typeof value?.error?.code === "string" ? value.error.code : "api_unavailable", response.status);
  if (value?.apiVersion !== VERSION || value.cluster !== "devnet" || value.error !== null || value.data?.kind !== kind || typeof value.provenance !== "string")
    throw new ApiError("invalid_api_response");
  const d = value.data;
  const strings = (...keys: string[]) => keys.every(k => typeof d[k] === "string");
  const valid = kind === "workflow_state" ? strings("internship","milestone","provenance") && ["offline_fixture","unverified_devnet_rpc"].includes(d.provenance)
    && d.provenance===value.provenance && ["student","verifier","requirementsHash","rewardAmountRaw","assignBy","submitBy","evidenceHash","verifiedAt","completion","settledAt","vaultAmountRaw"].every(k=>d[k]===null||typeof d[k]==="string")
    && (d.vaultClosed===null||typeof d.vaultClosed==="boolean") && Number.isSafeInteger(d.slot) && d.slot>=0 && d.commitment==="confirmed" && d.persisted===false && typeof d.internshipExists==="boolean" && typeof d.milestoneExists==="boolean"
    && (d.status===null || ["Created","Funded","Assigned","Submitted","Verified","Settled","Refunded"].includes(d.status)) && d.rewardPayment==="not_established"
    : kind === "workflow_verification_job" ? ["offline-test-only","controlled-devnet"].includes(d.mode) && strings("jobId","milestone","state") && ["none","passed","rejected"].includes(d.verificationOutcome) && d.persisted===true && d.attestation==="not_authorized" && d.rewardPayment==="not_established" && d.retryAuthorized===false
    : kind === "verification_handoff" ? d.request && typeof d.request==="object" && ["unavailable","contributor_admission_required"].includes(d.dispatch) && d.authorization==="not_granted" && d.persisted===false && d.rewardPayment==="not_established"
    : kind === "wallet_execution_recovery" ? strings("operationKey","recordedState")&&(d.signature===null||typeof d.signature==="string")&&(d.confirmation===null||["confirmed","failed","unknown"].includes(d.confirmation.state))&&d.retryAuthorized===false&&d.liveExecution===false
    : kind === "attestation_review" ? strings("jobId","reviewId","wallet","feePayer","verifier","messageBase58","expiresAt","scopeDigest","operationKey") && d.feePayer!==d.verifier && d.liveExecution===true && Number.isSafeInteger(d.signatureCount)&&d.signatureCount>=0&&d.signatureCount<=2&&Number.isSafeInteger(d.feeLamports)&&d.feeLamports>=0
    : kind === "attestation_signature" ? Number.isSafeInteger(d.signatureCount)&&d.signatureCount>=1&&d.signatureCount<=2
    : kind === "attestation_confirmation" ? strings("signature")&&["confirmed","failed","unknown"].includes(d.state)&&d.retryAuthorized===false
    : kind === "wallet_execution_authorization" ? d.liveExecution===true
    : kind === "wallet_execution_submission" ? strings("signature")&&["submitted","unknown"].includes(d.state)&&d.retryAuthorized===false
    : kind === "wallet_execution_revalidation" ? d.liveExecution === false && d.state === "ready_for_review"
    : kind === "wallet_execution_signature" ? d.liveExecution === false && strings("signature")
    : kind === "wallet_execution_confirmation" ? ["confirmed","failed","unknown"].includes(d.state) && strings("signature") && (d.rewardPayment === "not_established" || (d.state==="confirmed"&&d.rewardPayment==="exact_reward_confirmed"&&d.settlement&&d.settlement.vaultClosed===true
      && ["student","mint","sponsorDestination","completion"].every(k=>typeof d.settlement[k]==="string")
      && ["rewardAmountRaw","studentBeforeRaw","studentAfterRaw","sponsorSurplusRaw","rentReturnedRaw"].every(k=>typeof d.settlement[k]==="string"&&/^(0|[1-9][0-9]*)$/.test(d.settlement[k]))
      && BigInt(d.settlement.studentAfterRaw)-BigInt(d.settlement.studentBeforeRaw)===BigInt(d.settlement.rewardAmountRaw)))
    && d.retryAuthorized === false && (d.explorerUrl === null || typeof d.explorerUrl === "string")
    : kind === "wallet_execution_review" ? ["blocked","ready_for_review"].includes(d.state) && typeof d.liveExecution === "boolean"
    && strings("operation","wallet") && Array.isArray(d.blockers) && d.blockers.every((v:unknown)=>typeof v==="string") && d.rewardPayment === "not_established"
    && (d.deployment === null || (typeof d.deployment === "object" && typeof d.deployment.programExists === "boolean" && typeof d.deployment.executable === "boolean"
      && typeof d.deployment.artifactEquality === "string" && d.deployment.mint && typeof d.deployment.mint.exists === "boolean"))
    && (d.messageBase64 === null || typeof d.messageBase64 === "string")
    : kind === "workflow_preparation" ? d.stage === "unsigned_instruction_plan" && ["organization", "submission"].includes(d.action)
    && strings("internship", "milestone", "requirementsHash") && Array.isArray(d.steps) && d.steps.length > 0 && d.steps.length <= 4
    && d.terms && typeof d.terms === "object" && d.accountState === "not_observed" && d.idsReserved === false
    && d.signed === false && d.broadcast === false && d.verification === "not_run" && d.proposalAuthority === "not_proven" && d.rewardPayment === "not_established"
    : kind === "health" ? d.readiness === "limited" && strings("authentication", "applicationReads") && d.storage === "not_probed" && d.chain === "not_probed" && ["disabled","action_approval_required"].includes(d.execution)
    : kind === "verification_job" ? strings("jobId", "milestone", "state") && ["none", "passed", "rejected"].includes(d.verificationOutcome) && typeof d.reconciliationRequired === "boolean"
    : kind === "milestone_state" ? strings("address", "internship", "sponsor", "student", "rewardMint", "status", "rewardAmountRaw") && /^(0|[1-9][0-9]*)$/.test(d.rewardAmountRaw) && Number.isSafeInteger(d.slot) && d.programDeployment === "not_verified" && d.rewardPayment === "not_established"
    : kind === "execution_status" ? strings("jobId") && (d.phase === null || typeof d.phase === "string") && typeof d.reconciliationRequired === "boolean" && d.operationalExecution === "unavailable" && d.liveTransactionId === null && d.rewardPayment === "not_established"
    : kind === "wallet_logout" ? d.revoked === true
    : kind === "wallet_challenge" ? strings("wallet", "challengeId", "message", "issuedAt", "expiresAt")
    : kind === "wallet_session" ? strings("wallet", "expiresAt", "origin", "domain") : false;
  if (!valid) throw new ApiError("invalid_api_response");
  return { data: d as T, provenance: value.provenance };
}
export function message(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "wallet_rejected";
  const labels: Record<string, string> = {
    chain_reader_unavailable: "Chain observation is unavailable. The existing Devnet read configuration must be enabled; execution remains disabled.",
    chain_state_invalid: "The observed accounts are missing, inconsistent or invalid. No lifecycle success was accepted.",
    verification_dispatch_unavailable: "Independent verifier dispatch is not configured. An operator must admit contributor authentication and the approved runner; wallet login cannot substitute for that approval.",
    github_contributor_admission_required: "Independent GitHub contributor authentication has not been admitted for this exact work. No verification job was started.",
    verification_not_available: "Only the recorded student can prepare verification for an actual Submitted milestone.",
    invalid_verification_evidence: "The private verifier request is invalid or does not match the observed submission.",
    evidence_mismatch: "The private evidence and manifest do not match the actual submission commitments.",
    network_unavailable: "Could not reach the API. Check your connection and try again.",
    api_unavailable: "The wallet API is unavailable. The default backend does not register these routes.",
    authentication_required: "Your session expired. Sign in again to read this record.",
    authentication_failed: "The proof expired or could not be verified. Request a fresh challenge.",
    authentication_capacity: "Authentication is temporarily at capacity. Try again shortly.",
    authentication_rate_limited: "Too many attempts. Wait a minute before trying again.",
    wallet_missing: "Open this page in a Phantom-enabled browser. No supported wallet was found.",
    https_required: "Wallet sign-in requires the approved same-origin HTTPS backend. Demonstration mode works locally.",
    wallet_changed: "The wallet changed or disconnected. Sign in again with the intended account.",
    unsupported_signature: "This wallet did not return a raw 64-byte Ed25519 signature. No fallback format was used.",
    invalid_api_response: "The server returned an unsupported response. The sign-in or read could not be confirmed. No action was confirmed.",
    challenge_expired: "The challenge expired. Start sign-in again.",
    wallet_rejected: "The wallet request was cancelled or rejected. Stop and review the action state before any new attempt.",
  };
  if (error instanceof ApiError && error.status === 404) return "Record unavailable. It may not exist or this wallet may not have access.";
  return labels[code] ?? "This operation is unavailable. Please try again later.";
}
export const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
export interface Phantom {
  isPhantom: boolean;
  publicKey: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signMessage(bytes: Uint8Array, display: "utf8"): Promise<{ signature: Uint8Array; publicKey: { toBase58(): string } }>;
  on(event: "disconnect" | "accountChanged", listener: () => void): void;
  removeListener(event: "disconnect" | "accountChanged", listener: () => void): void;
}
declare global { interface Window { phantom?: { solana?: Phantom } } }
export function getWallet(): Phantom {
  const p = window.phantom?.solana;
  if (!p?.isPhantom || typeof p.signMessage !== "function" || typeof p.connect !== "function") throw new ApiError("wallet_missing");
  return p;
}
export async function authenticate(p: Phantom, current: () => boolean, beforeVerify: () => void = () => {}): Promise<Session> {
  if (location.protocol !== "https:") throw new ApiError("https_required");
  const connected = await p.connect(), wallet = connected.publicKey.toBase58();
  if (!current() || p.publicKey?.toBase58() !== wallet) throw new ApiError("wallet_changed");
  const { data: challenge } = await request<Challenge>(AUTH_ROUTES.challenge, "wallet_challenge", { ...ENVELOPE, wallet });
  if (!current() || p.publicKey?.toBase58() !== wallet) throw new ApiError("wallet_changed");
  if (challenge.wallet !== wallet || challenge.signedMessageFormat !== "siws-raw-ed25519" || typeof challenge.message !== "string"
    || challenge.message.length > 4096 || !/^[a-f0-9]{64}$/.test(challenge.challengeId)) throw new ApiError("invalid_api_response");
  const expiry = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new ApiError("challenge_expired");
  const issued = Date.parse(challenge.issuedAt);
  // Validate the fixed read-only context, but sign the original bytes without rebuilding them.
  const expected = `${location.host} wants you to sign in with your Solana account:\n${wallet}\n\nSign in to ProofOfWork for read-only application access. No transaction or payment is authorized.\n\nURI: ${location.origin}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${challenge.challengeId}\nIssued At: ${challenge.issuedAt}\nExpiration Time: ${challenge.expiresAt}\nRequest ID: ${challenge.challengeId}`;
  if (!Number.isFinite(issued) || expiry - issued !== 120_000 || challenge.message !== expected) throw new ApiError("invalid_api_response");
  // Only the exact returned UTF-8 message is signed. No signIn reconstruction, OCMS or transaction fallback.
  const bytes = new TextEncoder().encode(challenge.message), encoded = base64(bytes);
  const signed = await p.signMessage(bytes, "utf8");
  if (!current() || p.publicKey?.toBase58() !== wallet || signed.publicKey?.toBase58() !== wallet) throw new ApiError("wallet_changed");
  if (!(signed.signature instanceof Uint8Array) || signed.signature.length !== 64) throw new ApiError("unsupported_signature");
  if (Date.now() >= expiry) throw new ApiError("challenge_expired");
  beforeVerify();
  const { data: session } = await request<Session>(AUTH_ROUTES.verify, "wallet_session", { ...ENVELOPE, challengeId: challenge.challengeId,
    messageBase64: encoded, signatureBase64: base64(signed.signature) });
  if (!current() || p.publicKey?.toBase58() !== wallet) throw new ApiError("wallet_changed");
  if (session.wallet !== wallet || session.origin !== location.origin || session.domain !== location.host || session.cluster !== "devnet"
    || session.authenticationMethod !== "siws-raw-ed25519" || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now())
    throw new ApiError("invalid_api_response");
  return session;
}
