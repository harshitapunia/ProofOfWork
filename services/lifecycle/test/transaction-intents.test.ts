import { test } from "node:test";
import assert from "node:assert/strict";
import { bindings, error, temp } from "./job-helpers.js";
import { ready, metadata } from "./intent-helpers.js";
import type { PreparationInput, JobClaim } from "../src/index.js";

test("one permanent canonical intent binds the existing operation without duplicating authorization", t => {
  const s = temp(t).store(), { job, claim } = ready(s);
  const a = s.transactionIntents.createIntent(claim, job.revision, "request_a", job.bindings.sponsor);
  const b = s.transactionIntents.createIntent(claim, job.revision, "request_b", job.bindings.sponsor);
  assert.equal(a.created, true); assert.equal(b.created, false); assert.deepEqual(a.intent, b.intent);
  assert.equal(a.intent.jobId, job.jobId); assert.equal(a.intent.jobIdentity, job.identity);
  assert.equal(a.intent.operationKey, job.operationKey); assert.deepEqual(a.intent.bindings, job.bindings);
  assert.equal(a.intent.signingAuthorization, "not_granted"); assert.equal(a.intent.submissionAuthorized, false);
  assert.equal(a.intent.retryAuthorized, false); assert.equal(a.intent.reconciliationRequired, true);
  assert.ok(Object.isFrozen(a.intent) && Object.isFrozen(a.intent.bindings));
  assert.equal(s.transactionIntents.getIntentHistory(a.intent.intentId).length, 1);
});
test("strict preparation metadata is canonical independent of object insertion order and immutable", t => {
  const x = temp(t), s = x.store(), { job, claim } = ready(s);
  const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
  const input = metadata(), p = s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0, input);
  input.messageDigest = "cd".repeat(32);
  const reordered = Object.fromEntries(Object.entries(metadata()).reverse()) as unknown as PreparationInput;
  assert.deepEqual(s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 1, reordered), p);
  assert.equal(p.state, "preparation_recorded"); assert.equal(p.preparation!.messageDigest, metadata().messageDigest);
  assert.equal(p.reconciliationRequired, false); assert.ok(Object.isFrozen(p.preparation));
  assert.equal(s.transactionIntents.getIntentHistory(a.intentId).length, 2);
  assert.deepEqual(x.store().transactionIntents.getIntent(a.intentId), p);
});
for (const patch of [
  { messageDigest: "cd".repeat(32) }, { blockhash: "11111111111111111111111111111111" },
  { lastValidBlockHeight: "201" }, { observedBlockHeight: "101" },
]) {
  test("recorded preparation cannot change " + Object.keys(patch)[0], t => {
    const s = temp(t).store(), { job, claim } = ready(s);
    const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
    const recorded = s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0, metadata());
    assert.throws(() => s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 1, { ...metadata(), ...patch }));
    assert.deepEqual(s.transactionIntents.getIntent(a.intentId), recorded);
  });
}
for (const patch of [
  { messageDigest: "00".repeat(32) }, { messageDigest: "AB".repeat(32) }, { messageDigest: 123 },
  { format: "v0" }, { blockhash: "bad" }, { lastValidBlockHeight: "100" },
  { lastValidBlockHeight: "99" }, { lastValidBlockHeight: "0200" }, { lastValidBlockHeight: "18446744073709551616" },
  { observedBlockHeight: "-1" }, { observedBlockHeight: 1 }, { message: new Uint8Array() },
  { transactionId: "forged" }, { approved: true }, { signature: "forged" },
]) {
  test("invalid or injected preparation metadata rejects " + JSON.stringify(patch), t => {
    const s = temp(t).store(), { job, claim } = ready(s);
    const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
    assert.throws(() => s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0,
      { ...metadata(), ...patch } as unknown as PreparationInput));
    assert.equal(s.transactionIntents.getIntentHistory(a.intentId).length, 1);
  });
}
test("block heights safely preserve values beyond JavaScript safe integers through u64 max", t => {
  const s = temp(t).store(), { job, claim } = ready(s);
  const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
  const input = { ...metadata(), lastValidBlockHeight: "18446744073709551615", observedBlockHeight: "18446744073709551614" };
  const p = s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0, input);
  assert.equal(p.preparation!.lastValidBlockHeight, input.lastValidBlockHeight);
});
test("unknown properties, accessors, symbols and proxies cannot enter preparation metadata", t => {
  const s = temp(t).store(), { job, claim } = ready(s);
  const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
  const getter = Object.defineProperty({ ...metadata() }, "messageDigest", { enumerable: true, get: () => { throw Error("secret"); } });
  for (const bad of [getter, { ...metadata(), [Symbol()]: "injected" }, new Proxy(metadata(), { ownKeys() { throw Error("secret"); } })]) {
    assert.throws(() => s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0, bad));
    assert.equal(s.transactionIntents.getIntentHistory(a.intentId).length, 1);
  }
});
for (const to of ["rejectPreparation", "markPreparationUncertain", "requireReconciliation"] as const) {
  test("terminal bookkeeping " + to + " never permits another preparation or replacement intent", t => {
    const x = temp(t), s = x.store(), { job, claim } = ready(s);
    const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
    const terminal = s.transactionIntents[to](claim, job.revision, a.intentId, a.identity, 0);
    assert.throws(() => s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 1, metadata()), error("invalid_transition"));
    assert.deepEqual(x.store().transactionIntents.getIntent(a.intentId), terminal);
    const again = s.transactionIntents.createIntent(claim, job.revision, "different_request", job.bindings.sponsor);
    assert.equal(again.created, false); assert.equal(again.intent.intentId, a.intentId);
    assert.equal(s.transactionIntents.getIntentHistory(a.intentId).length, 2);
  });
}
test("reconciliation escalation retains the exact preparation and is terminal", t => {
  const s = temp(t).store(), { job, claim } = ready(s);
  const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
  const p = s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0, metadata());
  const last = s.transactionIntents.requireReconciliation(claim, job.revision, a.intentId, a.identity, 1);
  assert.deepEqual(last.preparation, p.preparation); assert.equal(last.reconciliationRequired, true);
  for (const method of ["rejectPreparation", "markPreparationUncertain", "requireReconciliation"] as const)
    assert.throws(() => s.transactionIntents[method](claim, job.revision, a.intentId, a.identity, 2));
});
test("different payer, canonical request collision and cross-job identities cannot substitute intent context", t => {
  const s = temp(t).store(), a = ready(s), b = ready(s, bindings(true));
  const first = s.transactionIntents.createIntent(a.claim, a.job.revision, "request", a.job.bindings.sponsor).intent;
  assert.throws(() => s.transactionIntents.createIntent(a.claim, a.job.revision, "new", a.job.bindings.student), error("intent_conflict"));
  assert.throws(() => s.transactionIntents.createIntent(b.claim, b.job.revision, "request", b.job.bindings.sponsor), error("intent_conflict"));
  assert.throws(() => s.transactionIntents.recordPreparation(b.claim, b.job.revision, first.intentId, first.identity, 0, metadata()), error("intent_conflict"));
});
for (const method of ["recordPreparation", "rejectPreparation", "markPreparationUncertain", "requireReconciliation"] as const) {
  for (const changed of ["jobId", "identity", "workerId", "generation", "jobRevision", "intentIdentity", "intentRevision"] as const) {
    test(method + " fences changed " + changed + " in its write transaction", t => {
      const s = temp(t).store(), { job, claim } = ready(s);
      const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
      const c = { ...claim } as JobClaim;
      const patch = changed === "jobId" ? { jobId: a.intentId } : changed === "identity" ? { identity: "cd".repeat(32) }
        : changed === "workerId" ? { workerId: "other" } : changed === "generation" ? { generation: 0 } : {};
      const args = [{ ...c, ...patch }, changed === "jobRevision" ? job.revision - 1 : job.revision, a.intentId,
        changed === "intentIdentity" ? "cd".repeat(32) : a.identity, changed === "intentRevision" ? 1 : 0] as const;
      assert.throws(() => method === "recordPreparation" ? s.transactionIntents[method](...args, metadata()) : s.transactionIntents[method](...args));
      assert.deepEqual(s.transactionIntents.getIntent(a.intentId), a);
    });
  }
}
test("revocation prevents every former-worker write and leaves reconciliation visible", t => {
  const s = temp(t).store(), { job, claim } = ready(s);
  const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
  const revoked = s.jobRecovery.interruptJob(job.jobId, job.identity, job.revision, "operator");
  assert.throws(() => s.transactionIntents.createIntent(claim, revoked.revision, "new", job.bindings.sponsor), error("stale_claim"));
  for (const method of ["recordPreparation", "rejectPreparation", "markPreparationUncertain", "requireReconciliation"] as const) {
    const args = [claim, revoked.revision, a.intentId, a.identity, 0] as const;
    assert.throws(() => method === "recordPreparation" ? s.transactionIntents[method](...args, metadata()) : s.transactionIntents[method](...args), error("stale_claim"));
  }
  assert.equal(s.transactionIntents.getIntent(a.intentId)!.state, "created");
  assert.equal(s.transactionIntents.listOutstandingIntents().entries[0]!.reconciliationRequired, true);
});
test("only authorization_pending job bookkeeping permits an intent; it does not grant signing", t => {
  const s = temp(t).store(), j = s.jobs.createOrGetJob("job", bindings()), c = s.jobs.claimJob(j.jobId, j.identity, 0, "worker");
  assert.throws(() => s.transactionIntents.createIntent(c.claim, c.job.revision, "request", j.bindings.sponsor), error("invalid_transition"));
  const running = s.jobs.transitionJob(c.claim, c.job.revision, "verification_running");
  assert.throws(() => s.transactionIntents.createIntent(c.claim, running.revision, "request", j.bindings.sponsor), error("invalid_transition"));
  const completed = s.jobs.transitionJob(c.claim, running.revision, "verification_completed");
  assert.throws(() => s.transactionIntents.createIntent(c.claim, completed.revision, "request", j.bindings.sponsor), error("invalid_transition"));
});
test("separate connections share permanent uniqueness and pagination retains every state", t => {
  const x = temp(t), s = x.store(), other = x.store(), a = ready(s), b = ready(s, bindings(true));
  const first = s.transactionIntents.createIntent(a.claim, a.job.revision, "a", a.job.bindings.sponsor);
  assert.equal(other.transactionIntents.createIntent(a.claim, a.job.revision, "alias", a.job.bindings.sponsor).created, false);
  other.transactionIntents.createIntent(b.claim, b.job.revision, "b", b.job.bindings.sponsor);
  const page = s.transactionIntents.listOutstandingIntents(undefined, 1);
  assert.equal(page.entries.length, 1); assert.equal(s.transactionIntents.listOutstandingIntents(page.nextAfter, 1).entries.length, 1);
  assert.equal(s.transactionIntents.getIntent(first.intent.intentId)!.identity, first.intent.identity);
  for (const limit of [0, 101, NaN]) assert.throws(() => s.transactionIntents.listOutstandingIntents(undefined, limit));
  s.close(); assert.throws(() => s.transactionIntents.getIntent(first.intent.intentId), error("closed"));
});

for (const field of ["verifier", "internship", "milestone", "submission", "programId"] as const) {
  test("intent fee payer cannot alias " + field, t => {
    const s = temp(t).store(), { job, claim } = ready(s);
    assert.throws(() => s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings[field]), error("invalid_fee_payer"));
    assert.equal(s.transactionIntents.listOutstandingIntents().entries.length, 0);
  });
}
