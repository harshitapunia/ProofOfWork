import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildAttestMilestoneInstruction, AttestationAuthorizer, AttestationError,
  createDevnetAttestationAuthorizer, type FutureAttestationSigner, type FutureDevnetTransport } from "../src/attestation.js";
import { DevnetAttestationReader, type AttestationStateReader, type AttestationState } from "../src/attestation-chain.js";
import { VerifierService, type VerificationResult } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { DockerRunner } from "../src/runner.js";
import { CASES } from "../src/manifest.js";
import { PROGRAM_ID } from "../src/commitments.js";
import { fixture, githubFetch, TOKEN } from "./helpers.js";

function setup() {
  const f = fixture();
  const chain = new DevnetAttestationReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc);
  let runs = 0;
  const service = new VerifierService(new GitHub(githubFetch()), chain, {
    run: async () => { runs++; return CASES.map(c => ({ id: c.id, passed: true })); },
  });
  const authorizer = new AttestationAuthorizer(service, chain, f.verifier.toBase58());
  return { ...f, student: new PublicKey(f.request.student), sponsor: new PublicKey(f.i.subarray(8, 40)), chain, service, authorizer, runs: () => runs };
}
const code = (expected: string) => (e: unknown) => e instanceof AttestationError && e.code === expected;

test("attestation ABI: exact program, discriminator, 104 bytes, argument offsets, account order/flags", async () => {
  const f = setup(), s = await f.chain.read(f.request.milestone);
  const ix = buildAttestMilestoneInstruction(s, f.verifier.toBase58());
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
  assert.equal(ix.data.length, 104);
  assert.equal(ix.data.subarray(0, 8).toString("hex"), "e5a7009640d3ed97");
  assert.deepEqual(ix.data.subarray(8, 40), f.student.toBuffer());
  assert.deepEqual(ix.data.subarray(40, 72), f.requirements);
  assert.deepEqual(ix.data.subarray(72, 104), f.evidence);
  assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [f.verifier.toBase58(), true, false], [f.internship.toBase58(), false, false],
    [f.milestone.toBase58(), false, true], [f.submission.toBase58(), false, false],
  ]);
});

test("validated reader retains internship/sponsor/ID bindings without changing ChainState", async () => {
  const f = setup(), s = await f.chain.read(f.request.milestone);
  assert.equal(s.internship, f.internship.toBase58()); assert.equal(s.sponsor, f.sponsor.toBase58());
  assert.equal(s.internshipId, "1"); assert.equal(s.milestoneId, "1");
});
for (const field of ["internship", "milestone", "submission"] as const) {
  test("builder rejects incorrect canonical " + field + " PDA", async () => {
    const f = setup(), s = await f.chain.read(f.request.milestone);
    assert.throws(() => buildAttestMilestoneInstruction({ ...s, [field]: f.student.toBase58() }, s.verifier), code(field + "_mismatch"));
  });
}
test("builder rejects wrong verifier and malformed commitment lengths", async () => {
  const f = setup(), s = await f.chain.read(f.request.milestone);
  assert.throws(() => buildAttestMilestoneInstruction(s, f.student.toBase58()), code("verifier_mismatch"));
  for (const field of ["requirementsHash", "evidenceHash"] as const)
    assert.throws(() => buildAttestMilestoneInstruction({ ...s, [field]: "ab" }, s.verifier));
});

test("trusted service runs before authorization; fresh read and unsigned mock signer/transport handoff", async () => {
  const f = setup();
  const ticket = await f.authorizer.prepare(f.request, TOKEN);
  assert.equal(f.runs(), 1);
  const ix = await f.authorizer.takeInstruction(ticket);
  assert.ok(ix instanceof TransactionInstruction);
  let signed = 0, sent = 0;
  // Test doubles only: no keys, transaction serialization, cryptographic signing or RPC writes.
  const signer: FutureAttestationSigner = { publicKey: f.verifier.toBase58(), sign: async instruction => {
    assert.equal(instruction.keys[0]?.pubkey.toBase58(), f.verifier.toBase58()); signed++; return Uint8Array.of(1);
  } };
  const transport: FutureDevnetTransport = { rpc: "https://api.devnet.solana.com", submit: async data => {
    assert.deepEqual(data, Uint8Array.of(1)); sent++; return "mock-only";
  } };
  assert.equal(await transport.submit(await signer.sign(ix)), "mock-only");
  assert.equal(signed, 1); assert.equal(sent, 1);
  await assert.rejects(f.authorizer.takeInstruction(ticket), code("invalid_authorization"));
  await assert.rejects(f.authorizer.prepare(f.request, TOKEN), code("duplicate_authorization"));
});

test("fake approval/attestation JSON and serialized tickets cannot authorize", async () => {
  const f = setup();
  await assert.rejects(f.authorizer.prepare({ approved: true, attestation: {} }, TOKEN), code("invalid_request"));
  await assert.rejects(f.authorizer.takeInstruction({ approved: true }), code("invalid_authorization"));
  const ticket = await f.authorizer.prepare(f.request, TOKEN);
  await assert.rejects(f.authorizer.takeInstruction(JSON.parse(JSON.stringify(ticket))), code("invalid_authorization"));
  await assert.rejects(f.authorizer.prepare({ ...f.request, approved: true }, TOKEN));
});

test("valid evidence plus extra fake approval fields is rejected by real service", async () => {
  const f = setup();
  await assert.rejects(f.authorizer.prepare({ ...f.request, approved: true }, TOKEN), code("verification_failed"));
  assert.equal(f.runs(), 0);
});
for (const target of ["student", "requirements", "evidence", "submission", "internship"] as const) {
  test("authorization rejects substituted " + target, async () => {
    const f = setup();
    if (target === "student") f.verifier.toBuffer().copy(f.m, 72);
    if (target === "requirements") f.m[200] = f.m[200]! ^ 1;
    if (target === "evidence") f.s[72] = f.s[72]! ^ 1;
    if (target === "submission") f.student.toBuffer().copy(f.m, 168);
    if (target === "internship") f.student.toBuffer().copy(f.m, 8);
    await assert.rejects(f.authorizer.prepare(f.request, TOKEN));
    assert.equal(f.runs(), 0);
  });
}
test("authorization rejects an incorrect designated verifier", async () => {
  const f = setup();
  const a = new AttestationAuthorizer(f.service, f.chain, f.student.toBase58());
  await assert.rejects(a.prepare(f.request, TOKEN), code("verifier_mismatch"));
});
test("missing authoritative chain state cannot issue an approval", async () => {
  const f = setup(); f.accounts.delete(f.milestone.toBase58());
  await assert.rejects(f.authorizer.prepare(f.request, TOKEN));
  assert.equal(f.runs(), 0);
});
test("failed GitHub verification or unavailable Docker cannot authorize", async () => {
  for (const unavailable of [false, true]) {
    const f = setup();
    const service = new VerifierService(new GitHub(githubFetch(unavailable ? {} : { "/user": { id: 9 } })),
      f.chain, unavailable ? new DockerRunner(undefined) : { run: async () => CASES.map(c => ({ id: c.id, passed: true })) });
    await assert.rejects(new AttestationAuthorizer(service, f.chain, f.verifier.toBase58()).prepare(f.request, TOKEN), code("verification_failed"));
  }
});
test("incorrect Docker outcomes cannot authorize", async () => {
  const f = setup();
  const service = new VerifierService(new GitHub(githubFetch()), f.chain, {
    run: async () => CASES.map(c => ({ id: c.id, passed: false })),
  });
  await assert.rejects(new AttestationAuthorizer(service, f.chain, f.verifier.toBase58()).prepare(f.request, TOKEN), code("verification_failed"));
});

test("changed state after service verification prevents ticket issue", async () => {
  const f = setup();
  const service = { verify: async (input: unknown, token: string) => {
    const result = await f.service.verify(input, token); f.m[136] = f.m[136]! ^ 1; return result;
  } };
  const a = new AttestationAuthorizer(service, f.chain, f.verifier.toBase58());
  await assert.rejects(a.prepare(f.request, TOKEN), code("stale_chain_state"));
});
test("changed state or terminal status before handoff burns the ticket", async () => {
  for (const offset of [136, 272]) {
    const f = setup(); const ticket = await f.authorizer.prepare(f.request, TOKEN);
    f.m[offset] = f.m[offset]! ^ 1;
    await assert.rejects(f.authorizer.takeInstruction(ticket));
    await assert.rejects(f.authorizer.takeInstruction(ticket), code("invalid_authorization"));
  }
});
for (const field of ["milestone", "submission", "verifier", "expected_student", "expected_requirements_hash", "expected_evidence_hash"] as const) {
  test("trusted-result consistency check rejects substituted " + field, async () => {
    const f = setup();
    const service = { verify: async (input: unknown, token: string): Promise<VerificationResult> => {
      const result = await f.service.verify(input, token);
      assert.ok(result.attestation); result.attestation[field] = "invalid-substitution"; return result;
    } };
    await assert.rejects(new AttestationAuthorizer(service, f.chain, f.verifier.toBase58()).prepare(f.request, TOKEN), code("result_binding_mismatch"));
  });
}
test("expired authorization fails closed before and after asynchronous state reread", async () => {
  const f = setup(); let time = 0;
  const a = new AttestationAuthorizer(f.service, f.chain, f.verifier.toBase58(), () => time);
  const ticket = await a.prepare(f.request, TOKEN); time = 30_000;
  await assert.rejects(a.takeInstruction(ticket), code("expired_authorization"));
  let handoff = false;
  const chain: AttestationStateReader = { read: async address => {
    const result = await f.chain.read(address); if (handoff) time = 60_000; return result;
  } };
  const b = new AttestationAuthorizer(f.service, chain, f.verifier.toBase58(), () => time);
  const second = await b.prepare(f.request, TOKEN); handoff = true;
  await assert.rejects(b.takeInstruction(second), code("expired_authorization"));
});
test("concurrent approval and handoff calls are single-use", async () => {
  const f = setup();
  const results = await Promise.allSettled([f.authorizer.prepare(f.request, TOKEN), f.authorizer.prepare(f.request, TOKEN)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const success = results.find(r => r.status === "fulfilled"); assert.ok(success?.status === "fulfilled");
  const handoffs = await Promise.allSettled([f.authorizer.takeInstruction(success.value), f.authorizer.takeInstruction(success.value)]);
  assert.equal(handoffs.filter(r => r.status === "fulfilled").length, 1);
});
test("reader rejects forged parent, corrupt account bytes, missing config and other endpoints", async () => {
  const f = setup();
  for (const [target, offset] of [[f.i, 48], [f.s, 0], [f.m, 273]] as const) {
    const old = target[offset]!; target[offset] = old ^ 1;
    await assert.rejects(f.chain.read(f.request.milestone)); target[offset] = old;
  }
  await assert.rejects(new DevnetAttestationReader(undefined, undefined, f.rpc).read(f.request.milestone));
  await assert.rejects(new DevnetAttestationReader("https://invalid.example", f.verifier.toBase58(), f.rpc).read(f.request.milestone));
  assert.throws(() => createDevnetAttestationAuthorizer({ rpc: "https://invalid.example", verifier: f.verifier.toBase58(), trustedImage: "" }), code("invalid_rpc"));
});
test("reader metadata mismatch cannot bypass canonical instruction construction", async () => {
  const f = setup();
  const valid = await f.chain.read(f.request.milestone);
  const bad: AttestationState = { ...valid, internshipId: "2" };
  assert.throws(() => buildAttestMilestoneInstruction(bad, f.verifier.toBase58()), code("internship_mismatch"));
});
