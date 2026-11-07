import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { AttestationAuthorizer, buildAttestMilestoneInstruction } from "../src/attestation.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { AttestationTransactionPolicy, TransactionPolicyError, type BlockhashObservation } from "../src/transaction-policy.js";
import { VerifierService } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { CASES } from "../src/manifest.js";
import { fixture, githubFetch, TOKEN } from "./helpers.js";

async function setup() {
  const f = fixture(); let time = 0;
  const chain = new DevnetAttestationReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc);
  const service = new VerifierService(new GitHub(githubFetch()), chain, {
    run: async () => CASES.map(c => ({ id: c.id, passed: true })),
  });
  const authorizer = new AttestationAuthorizer(service, chain, f.verifier.toBase58(), () => time);
  const config = { verifier: f.verifier.toBase58(), feePayer: new PublicKey(f.i.subarray(8, 40)).toBase58(),
    maxAgeMs: 5000, minRemainingBlockHeights: 10 };
  // Synthetic public blockhash only, NOT a wallet/keypair or a real blockchain observation.
  const observation: BlockhashObservation = { rpc: "https://api.devnet.solana.com",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(),
    lastValidBlockHeight: 200, currentBlockHeight: 100, observedAtMs: 0, valid: true };
  let onRead = () => {};
  const source = { read: async () => { onRead(); return { ...observation }; } };
  const policy = new AttestationTransactionPolicy(authorizer, chain, source, config, () => time);
  const state = await chain.read(f.request.milestone);
  const ix = buildAttestMilestoneInstruction(state, f.verifier.toBase58());
  const tx = () => new Transaction({ feePayer: new PublicKey(config.feePayer), recentBlockhash: observation.blockhash }).add(ix);
  const ticket = await authorizer.prepare(f.request, TOKEN);
  return { ...f, chain, authorizer, config, observation, source, policy, ix, tx, ticket,
    clock: (value: number) => { time = value; }, duringObservation: (fn: () => void) => { onRead = fn; } };
}
const wire = (t: Transaction) => t.serialize({ requireAllSignatures: false, verifySignatures: false });
const code = (value: string) => (e: unknown) => e instanceof TransactionPolicyError && e.code === value;

test("offline policy accepts exact unsigned legacy attestation and consumes immutable message once", async () => {
  const f = await setup(), candidate = wire(f.tx());
  const approval = await f.policy.authorize(f.ticket, candidate);
  candidate.fill(0); // The policy retained its own private snapshot.
  const message = await f.policy.consume(approval);
  assert.deepEqual(message, f.tx().serializeMessage());
  await assert.rejects(f.policy.consume(approval), code("invalid_transaction_authorization"));
  await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())));
});
for (const [label, offset] of [["discriminator", 0], ["student", 8], ["requirements hash", 40], ["evidence hash", 72]] as const) {
  test("rejects changed " + label, async () => {
    const f = await setup(); f.ix.data[offset] = f.ix.data[offset]! ^ 1;
    await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())));
  });
}
test("rejects wrong program ID", async () => {
  const f = await setup(); f.ix.programId = new PublicKey(f.config.feePayer);
  await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())));
});
for (const index of [0, 1, 2, 3]) {
  test("rejects substituted account at index " + index, async () => {
    const f = await setup(); f.ix.keys[index]!.pubkey = new PublicKey(f.request.student);
    await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())));
  });
}
for (const [index, flag] of [[0, "isSigner"], [0, "isWritable"], [1, "isWritable"], [2, "isWritable"], [3, "isSigner"]] as const) {
  test("rejects altered " + flag + " for account " + index, async () => {
    const f = await setup(); f.ix.keys[index]![flag] = !f.ix.keys[index]![flag];
    await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())));
  });
}
test("rejects reordered accounts", async () => {
  const f = await setup(); [f.ix.keys[1], f.ix.keys[3]] = [f.ix.keys[3]!, f.ix.keys[1]!];
  await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())));
});
test("rejects extra token-transfer instruction", async () => {
  const f = await setup();
  const transfer = new TransactionInstruction({ programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    keys: [], data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) });
  await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx().add(transfer))), code("unauthorized_instructions"));
});
test("rejects additional transfer, duplicate attestation and durable nonce advance", async () => {
  for (const kind of ["transfer", "duplicate", "nonce"]) {
    const f = await setup(), t = f.tx();
    t.add(kind === "duplicate" ? f.ix : kind === "transfer"
      ? SystemProgram.transfer({ fromPubkey: new PublicKey(f.config.feePayer), toPubkey: f.verifier, lamports: 1 })
      : SystemProgram.nonceAdvance({ noncePubkey: f.milestone, authorizedPubkey: f.verifier }));
    await assert.rejects(f.policy.authorize(f.ticket, wire(t)), code("unauthorized_instructions"));
  }
});
test("rejects wrong payer and verifier-as-payer permission elevation", async () => {
  const f = await setup(), t = f.tx(); t.feePayer = new PublicKey(f.request.student);
  await assert.rejects(f.policy.authorize(f.ticket, wire(t)), code("incorrect_fee_payer"));
  assert.throws(() => new AttestationTransactionPolicy(f.authorizer, f.chain, f.source,
    { ...f.config, feePayer: f.config.verifier }), code("separate_fee_payer_required"));
});
test("rejects fee payer alias with an attestation account", async () => {
  const f = await setup();
  const policy = new AttestationTransactionPolicy(f.authorizer, f.chain, f.source,
    { ...f.config, feePayer: f.internship.toBase58() }, () => 0);
  const t = f.tx(); t.feePayer = f.internship;
  await assert.rejects(policy.authorize(f.ticket, wire(t)));
});
for (const issue of ["different", "invalid", "expiredHeight", "tooLittleLifetime", "oldObservation", "futureObservation", "cluster", "badHash"] as const) {
  test("rejects blockhash issue: " + issue, async () => {
    const f = await setup(), candidate = wire(f.tx());
    if (issue === "different") f.observation.blockhash = new PublicKey(Buffer.alloc(32, 178)).toBase58();
    if (issue === "invalid") f.observation.valid = false;
    if (issue === "expiredHeight") f.observation.currentBlockHeight = 201;
    if (issue === "tooLittleLifetime") f.observation.currentBlockHeight = 195;
    if (issue === "oldObservation") f.clock(5000);
    if (issue === "futureObservation") f.observation.observedAtMs = 1;
    if (issue === "cluster") f.observation.genesisHash = "wrong-genesis";
    if (issue === "badHash") f.observation.blockhash = "malformed";
    await assert.rejects(f.policy.authorize(f.ticket, candidate));
  });
}
test("fake approval JSON, foreign handles and transaction bytes alone never authorize", async () => {
  const f = await setup();
  await assert.rejects(f.policy.authorize({ approved: true }, wire(f.tx())));
  await assert.rejects(f.policy.consume({ approved: true, message: wire(f.tx()) }), code("invalid_transaction_authorization"));
  const approval = await f.policy.authorize(f.ticket, wire(f.tx()));
  await assert.rejects(f.policy.consume(JSON.parse(JSON.stringify(approval))), code("invalid_transaction_authorization"));
  const other = new AttestationTransactionPolicy(f.authorizer, f.chain, f.source, f.config, () => 0);
  await assert.rejects(other.consume(approval), code("invalid_transaction_authorization"));
});
test("rejects changed chain state before authorization and before consumption", async () => {
  for (const phase of ["authorize", "consume"]) {
    const f = await setup();
    if (phase === "authorize") {
      f.m[136] = f.m[136]! ^ 1;
      await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())));
    } else {
      const approval = await f.policy.authorize(f.ticket, wire(f.tx()));
      f.m[136] = f.m[136]! ^ 1;
      await assert.rejects(f.policy.consume(approval), code("changed_onchain_bindings"));
      await assert.rejects(f.policy.consume(approval), code("invalid_transaction_authorization"));
    }
  }
});
test("expired approval and changed blockhash lease fail closed at handoff", async () => {
  for (const issue of ["age", "lease", "heightRegression"]) {
    const f = await setup(), approval = await f.policy.authorize(f.ticket, wire(f.tx()));
    if (issue === "age") f.clock(5000);
    if (issue === "lease") f.observation.blockhash = new PublicKey(Buffer.alloc(32, 179)).toBase58();
    if (issue === "heightRegression") f.observation.currentBlockHeight = 99;
    await assert.rejects(f.policy.consume(approval));
  }
});
test("concurrent consumption or evidence authorization yields at most one success", async () => {
  const f = await setup();
  const proposals = await Promise.allSettled([f.policy.authorize(f.ticket, wire(f.tx())), f.policy.authorize(f.ticket, wire(f.tx()))]);
  assert.equal(proposals.filter(p => p.status === "fulfilled").length, 1);
  const success = proposals.find(p => p.status === "fulfilled"); assert.ok(success?.status === "fulfilled");
  const consumed = await Promise.allSettled([f.policy.consume(success.value), f.policy.consume(success.value)]);
  assert.equal(consumed.filter(p => p.status === "fulfilled").length, 1);
});
test("rejects versioned, malformed, trailing and pre-signed transactions", async () => {
  const f = await setup();
  const versioned = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(f.config.feePayer),
    recentBlockhash: f.observation.blockhash, instructions: [f.ix] }).compileToV0Message());
  for (const value of [versioned.serialize(), Buffer.of(1, 2), Buffer.concat([wire(f.tx()), Buffer.of(1)]), Buffer.alloc(1233)])
    await assert.rejects(f.policy.authorize(f.ticket, value));
  const t = f.tx(); t.addSignature(f.verifier, Buffer.alloc(64, 1)); // Synthetic signature bytes, no signing keys.
  await assert.rejects(f.policy.authorize(f.ticket, wire(t)), code("signed_transaction_not_supported"));
});
test("slow trusted dependencies cannot extend authorization lifetime", async () => {
  const f = await setup(); f.duringObservation(() => { f.clock(5000); f.observation.observedAtMs = 5000; });
  await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())), code("stale_authorization_or_blockhash"));
});
test("mutating caller config cannot change copied payer/freshness policy", async () => {
  const f = await setup(); f.config.feePayer = f.request.student; f.config.maxAgeMs = 1_000_000;
  const candidate = f.tx();
  await assert.rejects(f.policy.authorize(f.ticket, wire(candidate)), code("incorrect_fee_payer"));
});

for (const phase of ["authorize", "consume"] as const) {
  test("rejects state changing during awaited blockhash observation: " + phase, async () => {
    const f = await setup();
    const approval = phase === "consume" ? await f.policy.authorize(f.ticket, wire(f.tx())) : undefined;
    // Simulate another worker attesting while the trusted provider awaits RPC.
    f.duringObservation(() => { f.m[272] = 4; });
    if (phase === "authorize") await assert.rejects(f.policy.authorize(f.ticket, wire(f.tx())));
    else {
      await assert.rejects(f.policy.consume(approval));
      await assert.rejects(f.policy.consume(approval), code("invalid_transaction_authorization"));
    }
  });
}
