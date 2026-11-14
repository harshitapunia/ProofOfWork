import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey, Transaction } from "@solana/web3.js";
import { FinanceClientError, PROGRAM_ID, DEMO_MINT, TOKEN_PROGRAM_ID,
  assignStudentInstruction, submitMilestoneInstruction, refundUnclaimedMilestoneInstruction,
  deriveInternship, deriveMilestone, deriveSubmission, deriveSponsorAta,
  type AssignStudentInput, type SubmitMilestoneInput, type RefundUnclaimedMilestoneInput,
} from "../src/index.js";

interface Abi { dataHex: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }
interface Vector {
  sponsor: string; student: string; internshipId: string; milestoneId: string;
  internship: string; milestone: string; submissionAddress: string; evidenceHash: string;
  assignment: Abi; submission: Abi; refund: Abi;
}
const fixture = JSON.parse(readFileSync(new URL("../../test/lifecycle-rust-abi.json", import.meta.url), "utf8")) as { programId: string; vectors: Vector[] };
const first = fixture.vectors[0]!;
const base = (v = first) => ({ sponsor: v.sponsor, internshipId: BigInt(v.internshipId), milestoneId: BigInt(v.milestoneId) });
const modes = [
  { name: "assignment", input: () => ({ ...base(), student: first.student }),
    build: (v: Record<string, unknown>) => assignStudentInstruction(v as unknown as AssignStudentInput) },
  { name: "submission", input: () => ({ ...base(), student: first.student, evidenceHash: first.evidenceHash }),
    build: (v: Record<string, unknown>) => submitMilestoneInstruction(v as unknown as SubmitMilestoneInput) },
  { name: "refund", input: () => base(),
    build: (v: Record<string, unknown>) => refundUnclaimedMilestoneInstruction(v as unknown as RefundUnclaimedMilestoneInput) },
];
const reason = (code: string) => (e: unknown) => e instanceof FinanceClientError && e.code === code;
const view = (ix: ReturnType<typeof assignStudentInstruction>) => ({ programId: ix.programId.toBase58(),
  dataHex: ix.data.toString("hex"),
  accounts: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) });

for (const [n, vector] of fixture.vectors.entries()) {
  test("compiled lifecycle Rust ABI vector " + n + ": exact bytes, ordering, flags and program", () => {
    const common = base(vector);
    for (const [actual, expected] of [
      [assignStudentInstruction({ ...common, student: vector.student }), vector.assignment],
      [submitMilestoneInstruction({ ...common, student: vector.student, evidenceHash: vector.evidenceHash }), vector.submission],
      [refundUnclaimedMilestoneInstruction(common), vector.refund],
    ] as const) {
      assert.equal(actual.programId.toBase58(), fixture.programId);
      assert.equal(actual.data.toString("hex"), expected.dataHex);
      assert.deepEqual(view(actual).accounts, expected.accounts);
    }
    assert.equal(fixture.programId, PROGRAM_ID);
    const [internship] = deriveInternship(common.sponsor, common.internshipId);
    const [milestone] = deriveMilestone(internship, common.milestoneId);
    assert.equal(internship.toBase58(), vector.internship);
    assert.equal(milestone.toBase58(), vector.milestone);
    assert.equal(deriveSubmission(milestone)[0].toBase58(), vector.submissionAddress);
  });
}

for (const mode of modes) {
  test(mode.name + ": unsigned transaction, correct role and bounded wire", () => {
    const ix = mode.build(mode.input());
    assert.equal(ix.keys.filter(k => k.isSigner).length, 1);
    const payer = ix.keys[0]!.pubkey;
    const tx = new Transaction({ feePayer: payer, recentBlockhash: first.internship }).add(ix);
    assert.ok(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232);
    assert.ok(tx.signatures.every(s => s.signature === null));
    assert.equal(payer.toBase58(), mode.name === "submission" ? first.student : first.sponsor);
  });
  for (const value of [-1n, 0x10000000000000000n, 1, "1", null, NaN]) {
    test(mode.name + ": rejects invalid ID " + String(value), () => {
      for (const field of ["internshipId", "milestoneId"])
        assert.throws(() => mode.build({ ...mode.input(), [field]: value }), reason("invalid_u64"));
    });
  }
  for (const value of ["bad!", "", 123, null]) {
    test(mode.name + ": rejects malformed sponsor " + String(value), () =>
      assert.throws(() => mode.build({ ...mode.input(), sponsor: value }), reason("invalid_public_key")));
  }
  test(mode.name + ": preserves existing sponsor-key policy without claiming signing authority", () => {
    assert.throws(() => mode.build({ ...mode.input(), sponsor: PublicKey.default }), reason("invalid_sponsor"));
    // Signer authority is enforced on-chain, including CPI signers; do not add an EOA-only policy.
    assert.doesNotThrow(() => mode.build({ ...mode.input(), sponsor: deriveInternship(first.sponsor, 1n)[0] }));
  });
  test(mode.name + ": rejects missing or unsupported argument shape", () => {
    for (const value of [null, undefined, [], 1, "input", {}])
      assert.throws(() => mode.build(value as never), reason("invalid_arguments"));
    for (const field of ["internship", "milestone", "submission", "sponsorDestination", "amount", "nonce", "githubToken"])
      assert.throws(() => mode.build({ ...mode.input(), [field]: first.student }), reason("invalid_arguments"));
    assert.throws(() => mode.build({ ...mode.input(), [Symbol("unsupported")]: true }), reason("invalid_arguments"));
  });
  test(mode.name + ": copies foreign PublicKey-shaped inputs and is immune to later caller mutation", () => {
    class ForeignKey {
      readonly bytes: Uint8Array;
      constructor(private readonly address: string) { this.bytes = new PublicKey(address).toBytes(); }
      toBytes() { return this.bytes; }
      toBase58() { return this.address; }
    }
    const sponsor = new ForeignKey(first.sponsor), student = new ForeignKey(first.student);
    assert.equal(sponsor instanceof PublicKey, false);
    const input: Record<string, unknown> = { ...mode.input(), sponsor };
    if (mode.name !== "refund") input.student = student;
    const expected = view(mode.build(mode.input()));
    const ix = mode.build(input);
    input.internshipId = 8n; input.milestoneId = 9n; sponsor.bytes.fill(0); student.bytes.fill(0);
    assert.deepEqual(view(ix), expected);
  });
}

for (const mode of modes.slice(0, 2)) {
  for (const value of ["bad!", null, 123]) {
    test(mode.name + ": malformed student " + String(value), () =>
      assert.throws(() => mode.build({ ...mode.input(), student: value }), reason("invalid_public_key")));
  }
  test(mode.name + ": zero/off-curve/sponsor student rejected", () => {
    for (const student of [PublicKey.default, deriveSubmission(new PublicKey(first.milestone))[0], first.sponsor])
      assert.throws(() => mode.build({ ...mode.input(), student }), reason("invalid_student"));
  });
}
for (const value of ["", "00".repeat(32), "ff".repeat(31), "ff".repeat(33), "zz".repeat(32),
  new Uint8Array(31), new Uint8Array(33), new Uint8Array(32), [], 123, null]) {
  test("submission: invalid evidence digest " + String(value).slice(0, 12), () =>
    assert.throws(() => submitMilestoneInstruction({ ...base(), student: first.student, evidenceHash: value as never }),
      reason("invalid_evidence_hash")));
}
test("submission: digest bytes copied; hex case and Uint8Array agree without serializing a preimage", () => {
  const bytes = new Uint8Array(32).fill(0xab);
  const input = { ...base(), student: first.student, evidenceHash: bytes };
  const ix = submitMilestoneInstruction(input); bytes.fill(0);
  assert.equal(ix.data.length, 40);
  assert.equal(ix.data.subarray(8).toString("hex"), "ab".repeat(32));
  assert.deepEqual(ix.data, submitMilestoneInstruction({ ...input, evidenceHash: "AB".repeat(32) }).data);
});
test("refund: classic mint/program restrictions and canonical ATA remain mandatory", () => {
  assert.throws(() => refundUnclaimedMilestoneInstruction({ ...base(), rewardMint: first.student }), reason("incorrect_mint"));
  assert.throws(() => refundUnclaimedMilestoneInstruction({ ...base(), tokenProgram: first.student }), reason("incorrect_token_program"));
  const ix = refundUnclaimedMilestoneInstruction({ ...base(), rewardMint: DEMO_MINT, tokenProgram: TOKEN_PROGRAM_ID });
  assert.equal(ix.keys[6]!.pubkey.toBase58(), deriveSponsorAta(first.sponsor).toBase58());
  assert.equal(ix.data.length, 8);
});
test("new role keys reject malformed cross-SDK shapes with stable errors", () => {
  for (const sponsor of [{}, { toBytes: () => new Uint8Array(31), toBase58: () => first.sponsor },
    { toBytes: () => new PublicKey(first.sponsor).toBytes(), toBase58: () => first.student },
    { toBytes: () => { throw Error("private input must not leak"); }, toBase58: () => first.sponsor }]) {
    for (const mode of modes)
      assert.throws(() => mode.build({ ...mode.input(), sponsor }), reason("invalid_public_key"));
  }
});
