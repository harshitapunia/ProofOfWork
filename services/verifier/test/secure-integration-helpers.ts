/** Offline TEST composition. Existing ephemeral providers retain keys only in their private test closures. */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { LifecycleStore, type ExecutionAttempt } from "@proofwork/lifecycle";
import { DEMO_MINT, deriveVault, deriveVaultAuthority, deriveCompletion } from "@proofwork/finance-client";
import { SecureOfflineAttestationIntegration, type OfflineIntegrationObservation } from "../src/secure-attestation-integration.js";
import { type OfflineReadPlan, type OfflineSourceBundle, type RawAccountSet, type OfflineReadSource } from "../src/read-only-observation.js";
import { protocolDataDigest } from "../src/operational-protocol.js";
import { transactionId } from "../src/devnet-execution.js";
import { protocolFixture } from "./protocol-helpers.js";
import { signingFixture } from "./signing-helpers.js";
import { fixture as rawFixture } from "./helpers.js";
export async function secureFixture(path: string, suppliedStore?: LifecycleStore) {
  const f = await signingFixture();
  new PublicKey(DEMO_MINT).toBuffer().copy(f.m, 136);
  f.m[274] = deriveVault(f.state.milestone)[1]; f.m[275] = deriveVaultAuthority(f.state.milestone)[1];
  const store = suppliedStore ?? new LifecycleStore(path), simulation = f.simulator();
  const config = { mode: "offline-only" as const, workerId: "worker", policy: f.config,
    observationAuthority: rawFixture().verifier.toBase58() };
  const calls: string[] = [];
  let changeBundle = (_bundle: OfflineSourceBundle) => {};
  let changePlan = (_plan: OfflineReadPlan) => {};
  let beforeStatus = async () => {}, beforeDetails = async () => {}, beforeAccounts = async () => {};
  let lastPlan: OfflineReadPlan | undefined, lastBundle: OfflineSourceBundle | undefined;
  function planFor(a: ExecutionAttempt): OfflineReadPlan {
    const data = protocolFixture(), prep = a.intent.preparation!, b = a.intent.bindings;
    const tx = f.transaction();
    tx.addSignature(new PublicKey(f.verifier.publicKey), f.verifier.signatures[0]!);
    tx.addSignature(new PublicKey(f.payer.publicKey), f.payer.signatures[0]!);
    const wire = tx.serialize(), wireDigest = createHash("sha256").update(wire).digest("hex");
    const anchor = { ...data.anchor, bindings: b, jobId: a.intent.jobId, jobIdentity: a.intent.jobIdentity,
      intentId: a.intent.intentId, intentIdentity: a.intent.identity, feePayer: a.intent.feePayer,
      messageDigest: prep.messageDigest, blockhash: prep.blockhash, lastValidBlockHeight: prep.lastValidBlockHeight,
      preparedAtBlockHeight: prep.observedBlockHeight, snapshotDigest: createHash("sha256").update(Buffer.concat([f.m,f.s,f.i])).digest("hex") };
    const admission = { ...data.admission, admissionId: a.intent.jobId, bindings: b, jobId: anchor.jobId,
      jobIdentity: anchor.jobIdentity, intentId: anchor.intentId, intentIdentity: anchor.intentIdentity,
      feePayer: anchor.feePayer, messageDigest: anchor.messageDigest, snapshotDigest: anchor.snapshotDigest,
      blockhash: prep.blockhash, lastValidBlockHeight: prep.lastValidBlockHeight, preparedAtBlockHeight: prep.observedBlockHeight,
      messageBase64: tx.serializeMessage().toString("base64"), operationKey: a.intent.operationKey };
    const submission = { ...data.submission, senderAdmissionId: a.intent.intentId, admissionId: admission.admissionId,
      admissionDigest: protocolDataDigest(admission), operationKey: a.intent.operationKey, messageDigest: prep.messageDigest,
      wireBase64: wire.toString("base64"), wireDigest, transactionId: transactionId(tx.signature!) };
    const plan: OfflineReadPlan = { kind: "offline_read_plan", attempt: { attemptId:a.attemptId,identity:a.identity,revision:a.revision },
      admission, submission, anchor, snapshot: data.snapshot, requestId: "fixture_query", minimumContextSlot: "120",
      events: [{sourceId:"fixture_provider",eventId:"fixture_event"}], priorEvents: [] };
    const provenance = (slot: string) => ({ ...data.observation.provenance, contextSlot:slot });
    const wrap = (address: string, bytes: Buffer) => ({ address, account: { owner:b.programId,executable:false,data:[bytes.toString("base64"),"base64"] as const } });
    const m = Buffer.from(f.m); m[272] = 4; m.writeBigInt64LE(160n,264);
    const accounts: RawAccountSet = { internship:wrap(b.internship,f.i), milestone:wrap(b.milestone,m), submission:wrap(b.submission,f.s),
      completion:{ address:deriveCompletion(b.milestone)[0].toBase58(),account:null } };
    const bundle: OfflineSourceBundle = { ...plan.events[0]!, interruption:null,
      status:{kind:"status_read",provenance:provenance("121"),currentBlockHeight:"150",evidence:{...data.status,
        transactionId:submission.transactionId,messageDigest:prep.messageDigest,wireDigest}},
      transaction:{kind:"transaction_read",provenance:provenance("122"),commitment:"finalized",transactionId:submission.transactionId,
        wireBase64:submission.wireBase64,wireDigest,transactionSlot:"120",outcome:"success",errorCode:null},
      accounts:{kind:"accounts_read",provenance:provenance("123"),commitment:"finalized",accounts} };
    changeBundle(bundle); changePlan(plan); lastPlan = plan; lastBundle = bundle; return plan;
  }
  const source: OfflineReadSource = { mode:"offline_mock",sourceId:"fixture_provider",
    readStatus:async()=>{calls.push("status");await beforeStatus();return lastBundle!.status;},
    readTransaction:async()=>{calls.push("details");await beforeDetails();return lastBundle!.transaction;},
    readAccounts:async()=>{calls.push("accounts");await beforeAccounts();return lastBundle!.accounts;} };
  const observation: OfflineIntegrationObservation = {sources:[source],readTimeoutMs:1000,planFor};
  const create = (s=store, observed:OfflineIntegrationObservation|undefined=observation, sim=simulation) =>
    new SecureOfflineAttestationIntegration(s,f.service,f.chain,f.source,config,sim,f.now,observed);
  const integration = create();
  const request = { mode:"offline-only",requestId:"integration",evidence:f.request };
  const rows = () => store.executionAttempts.list();
  const job = () => store.jobs.listRecoveryRequired().entries[0]!.job;
  const revoke = () => {const j=job();return store.jobRecovery.interruptJob(j.jobId,j.identity,j.revision,"operator");};
  return {...f,store,simulation,config,observationConfig:observation,readSource:source,integration,create,request,calls,rows,job,revoke,
    bundle:(fn:typeof changeBundle)=>{changeBundle=fn;},plan:(fn:typeof changePlan)=>{changePlan=fn;},
    onStatus:(fn:typeof beforeStatus)=>{beforeStatus=fn;},onDetails:(fn:typeof beforeDetails)=>{beforeDetails=fn;},
    onAccounts:(fn:typeof beforeAccounts)=>{beforeAccounts=fn;},lastPlan:()=>lastPlan,lastBundle:()=>lastBundle};
}
