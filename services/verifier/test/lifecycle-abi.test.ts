import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAttestMilestoneInstruction } from "../src/attestation.js";
import type { AttestationState } from "../src/attestation-chain.js";

interface Vector {
  sponsor: string; student: string; verifier: string; internshipId: string; milestoneId: string;
  internship: string; milestone: string; submissionAddress: string;
  requirementsHash: string; evidenceHash: string;
  attestation: { dataHex: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
}
const fixture = JSON.parse(readFileSync(new URL("../../../../packages/finance-client/test/lifecycle-rust-abi.json", import.meta.url), "utf8")) as { programId: string; vectors: Vector[] };
for (const [n, v] of fixture.vectors.entries()) {
  test("existing attestation builder matches compiled lifecycle Rust ABI " + n, () => {
    const state: AttestationState = { sponsor: v.sponsor, student: v.student, verifier: v.verifier,
      internshipId: v.internshipId, milestoneId: v.milestoneId, internship: v.internship,
      milestone: v.milestone, submission: v.submissionAddress,
      requirementsHash: v.requirementsHash, evidenceHash: v.evidenceHash, snapshot: "01".repeat(32) };
    const ix = buildAttestMilestoneInstruction(state, v.verifier);
    assert.equal(ix.programId.toBase58(), fixture.programId);
    assert.equal(ix.data.toString("hex"), v.attestation.dataHex);
    assert.equal(ix.keys.length, v.attestation.accounts.length);
    assert.deepEqual(ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      v.attestation.accounts);
  });
}
