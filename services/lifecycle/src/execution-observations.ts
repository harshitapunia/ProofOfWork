import { createHash, createPublicKey, verify } from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { address, check, exact } from "./common.js";
import { bindingText, identifier, sha } from "./job-model.js";
import { evidenceFields, requireSnapshot, type ExecutionAttempt, type ExecutionEvidence } from "./execution-model.js";

/** Public, signed fixture envelope, never operational RPC evidence. No private keys. */
export interface OfflineTestEnvelope {
  readonly evidence: ExecutionEvidence; readonly wireBase64: string; readonly authoritySignatureBase64: string;
}
export interface OfflineTestObservationSource {
  readonly mode: "offline-test-observation-source";
  read(attempt: ExecutionAttempt): Promise<OfflineTestEnvelope>;
}
export interface OfflineTestMessageValidator {
  readonly mode: "offline-fixture-message-validator";
  validate(attempt: ExecutionAttempt, unsignedMessage: Uint8Array): Promise<void>;
}
const tokens = new WeakMap<object, Readonly<ExecutionEvidence>>();
function bytes(s: unknown, length?: number): Buffer {
  check(typeof s === "string" && s.length <= 1644);
  const b = Buffer.from(s,"base64"); check(b.toString("base64") === s && (length === undefined || b.length === length)); return b;
}
/** Serialization only, not authentication. The signing implementation lives exclusively in tests. */
export function offlineTestStatement(e: ExecutionEvidence, wireBase64: string): Buffer {
  exact(e,evidenceFields); bytes(wireBase64);
  return Buffer.from(JSON.stringify(["proofwork:offline-test-execution-observation:v1",
    ...evidenceFields.map(k => e[k]), wireBase64]));
}
export function takeExecutionObservation(token: unknown): Readonly<ExecutionEvidence> {
  check(typeof token === "object" && token !== null, "untrusted_observation");
  const e = tokens.get(token); tokens.delete(token); check(e,"untrusted_observation"); return e;
}
/** Explicit test-only factory. Not an RPC adapter; no runtime route or network default. */
export function createOfflineTestExecutionObserver(source: OfflineTestObservationSource, validator: OfflineTestMessageValidator) {
  check(source.mode === "offline-test-observation-source" && validator.mode === "offline-fixture-message-validator");
  return Object.freeze({ async observe(attempt: ExecutionAttempt): Promise<object> {
    requireSnapshot(attempt);
    const input = await source.read(attempt);
    exact(input,["evidence","wireBase64","authoritySignatureBase64"]);
    exact(input.evidence,evidenceFields);
    const envelope = structuredClone(input);
    const e = envelope.evidence;
    identifier(e.eventId);
    check(e.attemptId === attempt.attemptId && e.identity === attempt.identity && e.revision === attempt.revision
      && e.intentIdentity === attempt.intent.identity && e.preparationIdentity === attempt.intent.preparation!.identity
      && e.bindingDigest === sha(bindingText(attempt.intent.bindings)), "observation_binding_mismatch");
    const publicKey = createPublicKey({format:"der",type:"spki",key:Buffer.concat([
      Buffer.from("302a300506032b6570032100","hex"),new PublicKey(address(attempt.observationAuthority)).toBuffer()])});
    check(verify(null,offlineTestStatement(e,envelope.wireBase64),publicKey,bytes(envelope.authoritySignatureBase64,64)), "untrusted_observation");
    const wire = bytes(envelope.wireBase64); check(wire.length <= 1232 && wire.length > 128);
    const tx = Transaction.from(wire);
    check(tx.serialize({requireAllSignatures:true,verifySignatures:true}).equals(wire), "noncanonical_transaction");
    check(tx.signatures.length === 2 && tx.signatures[0]!.publicKey.toBase58() === attempt.intent.feePayer
      && tx.signatures[1]!.publicKey.toBase58() === attempt.intent.bindings.verifier
      && tx.verifySignatures(true), "invalid_signatures");
    check(tx.recentBlockhash === attempt.intent.preparation!.blockhash && tx.signature !== null);
    // Base58 transaction ID is the complete first (fee-payer) signature, never a message hash.
    let n = BigInt("0x" + tx.signature.toString("hex")), id = "";
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    while (n > 0n) { id = alphabet[Number(n % 58n)]! + id; n /= 58n; }
    for (const b of tx.signature) { if (b !== 0) break; id = "1" + id; }
    const message = tx.serializeMessage();
    check(id === e.testTransactionId && createHash("sha256").update(wire).digest("hex") === e.wireDigest
      && createHash("sha256").update(message).digest("hex") === attempt.intent.preparation!.messageDigest, "transaction_identity_mismatch");
    await validator.validate(attempt,Buffer.from(message));
    const token = Object.freeze({}); tokens.set(token,Object.freeze(e)); return token;
  } });
}
