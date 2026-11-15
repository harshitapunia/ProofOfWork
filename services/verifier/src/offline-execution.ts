import { PublicKey, Transaction } from "@solana/web3.js";
import { createOfflineTestExecutionObserver, type OfflineTestObservationSource, type ExecutionAttempt,
  type ExecutionAttempts, type JobClaim, type ExecutionRef } from "@proofwork/lifecycle";
import { buildAttestMilestoneInstruction } from "./attestation.js";
import type { AttestationState } from "./attestation-chain.js";

function check(ok: unknown): asserts ok { if (!ok) throw new Error("offline_execution_rejected"); }
/** Trusted offline fixtures only. No default reader and no production RPC adapter. */
export interface OfflineExecutionFixture {
  readonly mode: "offline-attestation-fixture";
  read(milestone: string): Promise<AttestationState>;
}
export function offlineExecutionObserver(source: OfflineTestObservationSource, fixture: OfflineExecutionFixture) {
  check(fixture.mode === "offline-attestation-fixture");
  return createOfflineTestExecutionObserver(source,{ mode:"offline-fixture-message-validator", async validate(attempt,message) {
    const b = attempt.intent.bindings;
    const s = structuredClone(await fixture.read(b.milestone));
    for (const k of ["internship","sponsor","internshipId","milestoneId","milestone","submission","student","verifier",
      "requirementsHash","evidenceHash"] as const) check(s[k] === b[k]);
    const expected = new Transaction({ feePayer:new PublicKey(attempt.intent.feePayer),recentBlockhash:attempt.intent.preparation!.blockhash })
      .add(buildAttestMilestoneInstruction(s,b.verifier)).serializeMessage();
    check(expected.equals(Buffer.from(message)));
  } });
}
export interface OfflineInvocationDouble {
  readonly mode: "offline-invocation-double";
  /** Receives public digests only. No transaction bytes, signatures, keys or send API. */
  simulate(input: Readonly<{attemptId:string;identity:string;wireDigest:string}>): Promise<void>;
}
const ref = (a: ExecutionAttempt): ExecutionRef => ({attemptId:a.attemptId,identity:a.identity,revision:a.revision});
/** One newly created modeled attempt only. No replay, signing, transport or automatic retry. */
export class OfflineExecutionCoordinator {
  constructor(private readonly ledger: ExecutionAttempts,
    private readonly observer: ReturnType<typeof offlineExecutionObserver>,
    private readonly local: OfflineInvocationDouble, private readonly timeoutMs=1000) {
    check(local.mode === "offline-invocation-double" && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1000);
  }
  async model(c: JobClaim,jrev: number,requestId: string,intentId: string,intentIdentity: string,authority: string) {
    const created = this.ledger.create(c,jrev,requestId,intentId,intentIdentity,authority);
    check(created.created);
    let a = created.attempt;
    const token = await this.observer.observe(a);
    a = this.ledger.recordSubmissionIntent(c,jrev,ref(a),token);
    a = this.ledger.recordSimulatedInvocation(c,jrev,ref(a),"local-invocation");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.local.simulate(Object.freeze({attemptId:a.attemptId,identity:a.identity,wireDigest:a.wireDigest!})),
        new Promise<never>((_,reject) => {timer=setTimeout(()=>reject(new Error("ambiguous_local_timeout")),this.timeoutMs);})]);
      // Recheck current fencing, without recording an acknowledgment or inventing execution success.
      const current=this.ledger.markUncertain(c,jrev,ref(a),"local-returned-unknown");
      return Object.freeze({attempt:current,mode:"offline-test-model" as const,result:"returned_no_execution_claim" as const});
    } catch {
      // A revoked worker cannot commit even an uncertainty marker. The invocation record is already conservative.
      try { this.ledger.markUncertain(c,jrev,ref(a),"local-uncertain"); } catch { /* Recovery control must reconcile. */ }
      throw new Error("offline_execution_uncertain");
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
