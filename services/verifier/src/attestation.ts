import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, evidenceHash, hex, key, sha256, u64 } from "./commitments.js";
import { parseManifest, suiteCaseIds } from "./manifest.js";
import { VerifierService, type Request, type VerificationResult } from "./service.js";
import { sumV2OutcomesPass } from "./sum-v2.js";
import { GitHub } from "./github.js";
import { DockerRunner } from "./runner.js";
import { DevnetAttestationReader, type AttestationState, type AttestationStateReader } from "./attestation-chain.js";

export class AttestationError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AttestationError(code);
}
function validateState(s: AttestationState, verifier: string): void {
  check(s.verifier === verifier, "verifier_mismatch");
  key(verifier); key(s.student); hex(s.requirementsHash, 32); hex(s.evidenceHash, 32); hex(s.snapshot, 32);
  const [internship] = PublicKey.findProgramAddressSync([Buffer.from("internship"), key(s.sponsor).toBuffer(), u64(s.internshipId)], PROGRAM_ID);
  const [milestone] = PublicKey.findProgramAddressSync([Buffer.from("milestone"), internship.toBuffer(), u64(s.milestoneId)], PROGRAM_ID);
  const [submission] = PublicKey.findProgramAddressSync([Buffer.from("submission"), milestone.toBuffer()], PROGRAM_ID);
  check(internship.toBase58() === s.internship, "internship_mismatch");
  check(milestone.toBase58() === s.milestone, "milestone_mismatch");
  check(submission.toBase58() === s.submission, "submission_mismatch");
}

/** Pure unsigned ABI builder. Constructing an instruction is NOT authorization to sign. */
export function buildAttestMilestoneInstruction(state: AttestationState, verifier: string): TransactionInstruction {
  validateState(state, verifier);
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    { pubkey: key(verifier), isSigner: true, isWritable: false },
    { pubkey: key(state.internship), isSigner: false, isWritable: false },
    { pubkey: key(state.milestone), isSigner: false, isWritable: true },
    { pubkey: key(state.submission), isSigner: false, isWritable: false },
  ], data: Buffer.concat([sha256(Buffer.from("global:attest_milestone")).subarray(0, 8),
    key(state.student).toBuffer(), hex(state.requirementsHash, 32), hex(state.evidenceHash, 32)]) });
}

// These contracts describe a FUTURE trusted coordinator. No implementation/call site is shipped.
export interface FutureAttestationSigner {
  readonly publicKey: string;
  sign(instruction: TransactionInstruction): Promise<Uint8Array>;
}
export interface FutureDevnetTransport {
  readonly rpc: "https://api.devnet.solana.com";
  submit(signedTransaction: Uint8Array): Promise<string>;
}

function sameState(a: AttestationState, b: AttestationState): boolean {
  return (Object.keys(a) as (keyof AttestationState)[]).every(k => a[k] === b[k])
    && Object.keys(a).length === Object.keys(b).length;
}
function validateResult(r: VerificationResult, s: AttestationState, request: Request, ids: readonly string[], isV2: boolean): void {
  check(r.approved === true && r.status === "passed" && r.reason === undefined, "verification_failed");
  check(isV2 ? sumV2OutcomesPass(r.outcomes)
    : Array.isArray(r.outcomes) && r.outcomes.length === ids.length
      && ids.every((id,index)=>Object.hasOwn(r.outcomes,index) && r.outcomes[index]?.id === id && r.outcomes[index]?.passed === true), "verification_failed");
  check(r.milestone === s.milestone && r.student === s.student && r.requirementsHash === s.requirementsHash
    && r.evidenceHash === s.evidenceHash && r.repositoryId === request.repositoryId
    && r.contributorId === request.contributorId && r.commit === request.commit, "result_binding_mismatch");
  const a = r.attestation;
  check(a && a.milestone === s.milestone && a.submission === s.submission && a.verifier === s.verifier
    && a.expected_student === s.student && a.expected_requirements_hash === s.requirementsHash
    && a.expected_evidence_hash === s.evidenceHash, "result_binding_mismatch");
}

/** Server-internal only. Dependencies are trusted code, never request-provided adapters. */
export class AttestationAuthorizer {
  readonly #tickets = new WeakMap<object, { state: AttestationState; issued: number }>();
  readonly #reserved = new Set<string>();
  constructor(private readonly service: Pick<VerifierService, "verify">,
    private readonly chain: AttestationStateReader, private readonly verifier: string,
    private readonly now: () => number = () => performance.now()) { key(verifier); }

  /** Accepts evidence requests, NEVER VerificationResult/attestation JSON. Runs verification afresh. */
  async prepare(input: unknown, githubToken: string): Promise<object> {
    // Copy before awaiting: the caller cannot mutate a request during execution.
    let request: Request;
    try { request = structuredClone(input) as Request; }
    catch { throw new AttestationError("invalid_request"); }
    check(request && typeof request.milestone === "string", "invalid_request");
    const milestone = key(request.milestone).toBase58();
    check(!this.#reserved.has(milestone), "duplicate_authorization");
    this.#reserved.add(milestone);
    let issued = false;
    try {
      const initial = structuredClone(await this.chain.read(milestone));
      validateState(initial, this.verifier);
      check(initial.milestone === milestone && initial.student === request.student, "request_binding_mismatch");
      const manifestBytes = Buffer.from(request.manifestBase64, "base64");
      check(manifestBytes.toString("base64") === request.manifestBase64, "invalid_request");
      const { hash, manifest } = parseManifest(manifestBytes);
      check(hash.toString("hex") === initial.requirementsHash, "requirements_mismatch");
      check(evidenceHash({ ...request, requirementsHash: initial.requirementsHash }).toString("hex") === initial.evidenceHash, "evidence_mismatch");
      // Only the result of this trusted execution is examined; no method accepts a caller result.
      const result = await this.service.verify(structuredClone(request), githubToken);
      validateResult(result, initial, request, suiteCaseIds(manifest), manifest.task === "sum-v2");
      const current = structuredClone(await this.chain.read(milestone));
      validateState(current, this.verifier);
      check(sameState(initial, current), "stale_chain_state");
      const ticket = Object.freeze({});
      this.#tickets.set(ticket, { state: current, issued: this.now() });
      issued = true;
      return ticket;
    } finally {
      // Successful issue reserves this milestone for this instance's lifetime, even after expiry.
      if (!issued) this.#reserved.delete(milestone);
    }
  }

  /** One-shot server handoff of a freshly rebuilt unsigned instruction; no signing capability. */
  async takeInstruction(ticket: unknown): Promise<TransactionInstruction> {
    check(typeof ticket === "object" && ticket !== null, "invalid_authorization");
    const record = this.#tickets.get(ticket);
    check(record, "invalid_authorization");
    this.#tickets.delete(ticket); // Burn BEFORE awaiting, so concurrent/replayed calls fail closed.
    const age = this.now() - record.issued;
    check(Number.isFinite(age) && age >= 0 && age < 30_000, "expired_authorization");
    const current = structuredClone(await this.chain.read(record.state.milestone));
    validateState(current, this.verifier);
    check(sameState(record.state, current), "stale_chain_state");
    check(this.now() - record.issued < 30_000, "expired_authorization");
    return buildAttestMilestoneInstruction(current, this.verifier);
  }
}

/** Production composition; configure only from trusted local server configuration. No HTTP route. */
export function createDevnetAttestationAuthorizer(config: { rpc: string; verifier: string; trustedImage: string }): AttestationAuthorizer {
  check(config.rpc === "https://api.devnet.solana.com", "invalid_rpc");
  const chain = new DevnetAttestationReader(config.rpc, config.verifier);
  const service = new VerifierService(new GitHub(), chain, new DockerRunner(config.trustedImage));
  return new AttestationAuthorizer(service, chain, config.verifier);
}
