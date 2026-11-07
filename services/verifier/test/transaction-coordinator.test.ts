import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Transaction } from "@solana/web3.js";
import { AttestationTransactionCoordinator, CoordinatorError, type MockMessageBoundary } from "../src/transaction-coordinator.js";
import { AttestationError, buildAttestMilestoneInstruction } from "../src/attestation.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { TransactionPolicyError, type BlockhashObservation } from "../src/transaction-policy.js";
import { VerificationError } from "../src/errors.js";
import { VerifierService } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { CASES } from "../src/manifest.js";
import { fixture, githubFetch, TOKEN } from "./helpers.js";

/** Uses real authorization/policy/service classes with mocked GitHub, RPC, Docker and message handoff. */
async function setup(options: { githubFail?: boolean; dockerFail?: boolean } = {}) {
  const f = fixture(); let time = 0, reads = 0, runs = 0;
  let duringRead = (_n: number) => {};
  const chain = new DevnetAttestationReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc);
  const service = new VerifierService(new GitHub(githubFetch(options.githubFail ? { "/user": { id: 999 } } : {})), chain,
    { run: async () => { runs++; return CASES.map(c => ({ id: c.id, passed: !options.dockerFail })); } });
  const config = { verifier: f.verifier.toBase58(), feePayer: new PublicKey(f.i.subarray(8, 40)).toBase58(),
    maxAgeMs: 5000, minRemainingBlockHeights: 10 };
  const observation: BlockhashObservation = { rpc: "https://api.devnet.solana.com",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(), lastValidBlockHeight: 200,
    currentBlockHeight: 100, observedAtMs: 0, valid: true };
  const source = { read: async () => { duringRead(++reads); return { ...observation }; } };
  const messages: Buffer[] = [];
  const boundary = { mode: "offline-mock" as const, publicKey: config.verifier,
    acceptAuthorizedMessage: async (message: Uint8Array) => { messages.push(Buffer.from(message)); } } satisfies MockMessageBoundary;
  const create = () => new AttestationTransactionCoordinator(service, chain, config, boundary, source, () => time);
  const coordinator = create();
  const expected = new Transaction({ feePayer: new PublicKey(config.feePayer), recentBlockhash: observation.blockhash })
    .add(buildAttestMilestoneInstruction(await chain.read(f.request.milestone), config.verifier)).serializeMessage();
  return { ...f, config, observation, boundary, messages, coordinator, create, expected,
    onRead: (fn: (n: number) => void) => { duringRead = fn; }, clock: (n: number) => { time = n; }, runs: () => runs };
}
/** Requires the precise rejection class and reason. */
const code = (type: typeof AttestationError | typeof TransactionPolicyError | typeof CoordinatorError | typeof VerificationError,
  reason: string) => (e: unknown) => e instanceof type && e.code === reason;

test("coordinator hands only exact canonical authorized bytes to mock; sequential replay fails", async () => {
  const f = await setup();
  await f.coordinator.coordinate(f.request, TOKEN);
  assert.equal(f.messages.length, 1); assert.deepEqual(f.messages[0], f.expected); assert.equal(f.runs(), 1);
  await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(AttestationError, "duplicate_authorization"));
  assert.equal(f.messages.length, 1);
});
for (const failure of ["github", "docker"] as const) {
  test("failed " + failure + " verification never reaches handoff", async () => {
    const f = await setup({ githubFail: failure === "github", dockerFail: failure === "docker" });
    await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(AttestationError, "verification_failed"));
    assert.equal(f.messages.length, 0); assert.equal(f.runs(), failure === "github" ? 0 : 1);
  });
}
test("rejects verifier as payer and fee payer aliased to instruction account", async () => {
  const f = await setup(); f.config.feePayer = f.config.verifier;
  assert.throws(f.create, code(TransactionPolicyError, "separate_fee_payer_required"));
  f.config.feePayer = f.internship.toBase58();
  // Payer promotion makes the readonly internship writable; exact instruction comparison rejects first.
  await assert.rejects(f.create().coordinate(f.request, TOKEN), code(TransactionPolicyError, "transaction_substitution"));
  assert.equal(f.messages.length, 0);
});
test("copies trusted payer configuration against later substitution", async () => {
  const f = await setup(); f.config.feePayer = f.request.student;
  await f.coordinator.coordinate(f.request, TOKEN);
  assert.deepEqual(f.messages[0], f.expected);
});
test("incorrect mock verifier and non-mock boundary rejected", async () => {
  const f = await setup(); f.boundary.publicKey = f.request.student;
  assert.throws(f.create, code(CoordinatorError, "incorrect_mock_signer"));
  await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(CoordinatorError, "incorrect_mock_signer"));
  f.boundary.publicKey = f.config.verifier;
  Object.assign(f.boundary, { mode: "real" });
  assert.throws(f.create, code(CoordinatorError, "incorrect_mock_signer"));
  assert.equal(f.messages.length, 0);
});
test("mock identity changed while awaiting chain/blockhash cannot receive message", async () => {
  const f = await setup(); f.onRead(n => { if (n === 3) f.boundary.publicKey = f.request.student; });
  await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(CoordinatorError, "incorrect_mock_signer"));
  assert.equal(f.messages.length, 0);
});
test("wrong designated verifier in authoritative state fails closed", async () => {
  const f = await setup(); new PublicKey(f.request.student).toBuffer().copy(f.m, 104);
  await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(VerificationError, "invalid_onchain_state"));
  assert.equal(f.messages.length, 0);
});
test("caller approval JSON and injected transaction instructions are not accepted", async () => {
  const f = await setup();
  await assert.rejects(f.coordinator.coordinate({ ...f.request, approved: true, transaction: f.expected, instructions: [] }, TOKEN),
    code(AttestationError, "verification_failed"));
  assert.equal(f.messages.length, 0);
});
test("request mutation during async execution cannot substitute a different milestone/student", async () => {
  const f = await setup(); const pending = f.coordinator.coordinate(f.request, TOKEN);
  f.request.student = f.config.feePayer; f.request.milestone = f.internship.toBase58();
  await pending; assert.deepEqual(f.messages[0], f.expected);
});
for (const phase of [1, 2, 3]) {
  test("expired blockhash fails before handoff at read " + phase, async () => {
    const f = await setup(); f.onRead(n => { if (n === phase) f.observation.valid = false; });
    await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(TransactionPolicyError, "invalid_or_expired_blockhash"));
    assert.equal(f.messages.length, 0);
  });
}
test("substituted blockhash lease at consumption fails closed", async () => {
  const f = await setup(); f.onRead(n => { if (n === 3) f.observation.blockhash = new PublicKey(Buffer.alloc(32, 178)).toBase58(); });
  await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(TransactionPolicyError, "changed_blockhash_lease"));
  assert.equal(f.messages.length, 0);
});
for (const phase of [1, 2, 3]) {
  test("changed on-chain state at read " + phase + " blocks handoff", async () => {
    const f = await setup(); f.onRead(n => { if (n === phase) f.m[272] = 4; });
    await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(VerificationError, "invalid_onchain_state"));
    assert.equal(f.messages.length, 0);
  });
}
test("expired authorization never reaches handoff", async () => {
  const f = await setup(); f.onRead(n => { if (n === 2) { f.clock(5000); f.observation.observedAtMs = 5000; } });
  await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(TransactionPolicyError, "stale_authorization_or_blockhash"));
  assert.equal(f.messages.length, 0);
});
test("concurrent duplicate requests hand off at most once", async () => {
  const f = await setup();
  const results = await Promise.allSettled([f.coordinator.coordinate(f.request, TOKEN), f.coordinator.coordinate(f.request, TOKEN)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const failed = results.find(r => r.status === "rejected"); assert.ok(failed?.status === "rejected");
  assert.ok(code(AttestationError, "duplicate_authorization")(failed.reason));
  assert.equal(f.messages.length, 1); assert.equal(f.runs(), 1);
});
test("ambiguous mock-boundary failure burns authorization and cannot retry", async () => {
  const f = await setup(); let attempts = 0;
  f.boundary.acceptAuthorizedMessage = async () => { attempts++; throw new Error("mock_failure"); };
  await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), { message: "mock_failure" });
  await assert.rejects(f.coordinator.coordinate(f.request, TOKEN), code(AttestationError, "duplicate_authorization"));
  assert.equal(attempts, 1);
});
