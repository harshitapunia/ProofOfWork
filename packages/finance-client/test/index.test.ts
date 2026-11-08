import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { FinanceClientError, PROGRAM_ID, DEMO_MINT, TOKEN_PROGRAM_ID, deriveInternship, deriveMilestone,
  deriveVault, deriveVaultAuthority, deriveSponsorAta, createInternshipInstruction, createMilestoneInstruction,
  fundMilestoneInstruction, type MilestoneInput, type FundingInput, type PublicKeyInput } from "../src/index.js";

interface Abi { dataHex: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }
interface Vector {
  sponsor: string; verifier: string; internshipId: string; milestoneId: string; rewardAmount: string; assignBy: string; submitBy: string;
  pdas: { internship: [string, number]; milestone: [string, number]; vault: [string, number]; vaultAuthority: [string, number]; sponsorAta: string };
  createInternship: Abi; createMilestone: Abi; fundMilestone: Abi;
}
const fixture = JSON.parse(readFileSync(new URL("../../test/rust-abi.json", import.meta.url), "utf8")) as { programId: string; mint: string; vectors: Vector[] };
const first = fixture.vectors[0]!;
const input = (v = first): MilestoneInput => ({ sponsor: v.sponsor, verifier: v.verifier, internshipId: BigInt(v.internshipId),
  milestoneId: BigInt(v.milestoneId), rewardAmount: BigInt(v.rewardAmount), requirementsHash: "05".repeat(32),
  assignBy: BigInt(v.assignBy), submitBy: BigInt(v.submitBy), nowUnixSeconds: 1n });
const reason = (code: string) => (error: unknown) => error instanceof FinanceClientError && error.code === code;
const pda = ([key, bump]: [PublicKey, number]) => [key.toBase58(), bump];

for (const [n, vector] of fixture.vectors.entries()) {
  test("compiled Rust ABI vector " + n + ": exact instruction bytes, account order and flags", () => {
    const value = input(vector);
    for (const [build, expected] of [[createInternshipInstruction, vector.createInternship],
      [createMilestoneInstruction, vector.createMilestone], [fundMilestoneInstruction, vector.fundMilestone]] as const) {
      const actual = build(value);
      assert.equal(actual.programId.toBase58(), fixture.programId);
      assert.equal(actual.data.toString("hex"), expected.dataHex);
      assert.deepEqual(actual.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), expected.accounts);
    }
    assert.equal(fixture.programId, PROGRAM_ID); assert.equal(fixture.mint, DEMO_MINT);
  });
  test("compiled Rust PDA/ATA vector " + n + ": canonical addresses and bumps", () => {
    const [internship] = deriveInternship(vector.sponsor, BigInt(vector.internshipId));
    const [milestone] = deriveMilestone(internship, BigInt(vector.milestoneId));
    assert.deepEqual(pda(deriveInternship(vector.sponsor, BigInt(vector.internshipId))), vector.pdas.internship);
    assert.deepEqual(pda(deriveMilestone(internship, BigInt(vector.milestoneId))), vector.pdas.milestone);
    assert.deepEqual(pda(deriveVault(milestone)), vector.pdas.vault);
    assert.deepEqual(pda(deriveVaultAuthority(milestone)), vector.pdas.vaultAuthority);
    assert.equal(deriveSponsorAta(vector.sponsor).toBase58(), vector.pdas.sponsorAta);
  });
}
for (const [name, build] of [["create_internship", createInternshipInstruction], ["create_milestone", createMilestoneInstruction], ["fund_milestone", fundMilestoneInstruction]] as const) {
  test("exact Anchor discriminator: " + name, () => {
    assert.deepEqual(build(input()).data.subarray(0,8), createHash("sha256").update("global:" + name).digest().subarray(0,8));
  });
}
test("u64 values above Number.MAX_SAFE_INTEGER and i64 upper limits round-trip exactly", () => {
  const value = input(fixture.vectors[1]!);
  const ix = createMilestoneInstruction(value);
  assert.equal(ix.data.length,104); assert.equal(ix.data.readBigUInt64LE(8),0xffffffffffffffffn);
  assert.equal(ix.data.readBigUInt64LE(16),0xffffffffffffffffn);
  assert.equal(ix.data.readBigInt64LE(56),0x7ffffffffffffffen);
  assert.equal(ix.data.readBigInt64LE(64),0x7fffffffffffffffn);
  assert.equal(createInternshipInstruction(value).data.length,16);
  assert.equal(fundMilestoneInstruction(value).data.length,8);
});
for (const value of [-1n,0x10000000000000000n,1,Number.MAX_SAFE_INTEGER+1,"1",null]) {
  test("rejects invalid or imprecise ID: " + String(value), () => {
    assert.throws(() => createInternshipInstruction({ ...input(), internshipId: value as bigint }), reason("invalid_u64"));
    assert.throws(() => fundMilestoneInstruction({ ...input(), milestoneId: value as bigint }), reason("invalid_u64"));
  });
}
for (const value of [-1n,0x10000000000000000n,1,"1",null]) {
  test("rejects invalid raw reward amount: " + String(value), () => {
    assert.throws(() => createMilestoneInstruction({ ...input(), rewardAmount: value as bigint }), reason("invalid_u64"));
  });
}
test("zero reward rejected while zero scoped IDs remain valid", () => {
  assert.throws(() => createMilestoneInstruction({ ...input(), rewardAmount: 0n }), reason("invalid_reward_amount"));
  assert.doesNotThrow(() => createMilestoneInstruction({ ...input(), internshipId:0n, milestoneId:0n }));
});
for (const value of ["", "bad!", "1", null, 123]) {
  test("rejects malformed public key: " + String(value), () => {
    assert.throws(() => createInternshipInstruction({ ...input(), sponsor: value as PublicKeyInput }), reason("invalid_public_key"));
    assert.throws(() => createMilestoneInstruction({ ...input(), verifier: value as PublicKeyInput }), reason("invalid_public_key"));
  });
}
for (const value of ["00".repeat(32),"gg".repeat(32),"05".repeat(31),"05".repeat(33),new Uint8Array(32),new Uint8Array(31),null]) {
  test("rejects malformed or empty requirements hash " + String(value).slice(0,12), () => {
    assert.throws(() => createMilestoneInstruction({ ...input(), requirementsHash: value as string }), reason("invalid_requirements_hash"));
  });
}
test("copies hash bytes and supports wallet-adapter PublicKey input without mutation", () => {
  const hash = new Uint8Array(32).fill(5), sponsor = new PublicKey(first.sponsor);
  const ix = createMilestoneInstruction({ ...input(), sponsor, requirementsHash: hash }); hash.fill(0);
  assert.equal(ix.data.toString("hex"), first.createMilestone.dataHex);
  assert.notEqual(ix.keys[0]!.pubkey,sponsor);
});
for (const verifier of [PublicKey.default.toBase58(),first.sponsor,first.pdas.vaultAuthority[0]]) {
  test("rejects invalid verifier role: " + verifier, () => {
    assert.throws(() => createMilestoneInstruction({ ...input(), verifier }), reason("invalid_verifier"));
  });
}
for (const change of [{ nowUnixSeconds:0n },{ nowUnixSeconds:200n },{ assignBy:0n },{ assignBy:300n },{ submitBy:200n },{ submitBy:-1n }]) {
  test("rejects invalid deadline ordering: " + Object.keys(change)[0] + String(Object.values(change)[0]), () => {
    assert.throws(() => createMilestoneInstruction({ ...input(), ...change }), reason("invalid_deadlines"));
  });
}
for (const value of [0x8000000000000000n,-0x8000000000000001n,100,"100",null]) {
  test("rejects malformed or overflowing timestamp: " + String(value), () => {
    assert.throws(() => createMilestoneInstruction({ ...input(), assignBy:value as bigint }), reason("invalid_i64"));
  });
}
for (const build of [createMilestoneInstruction,fundMilestoneInstruction]) {
  test(build.name + " rejects alternate mint and Token-2022", () => {
    assert.throws(() => build({ ...input(), rewardMint:"So11111111111111111111111111111111111111112" }),reason("incorrect_mint"));
    assert.throws(() => build({ ...input(), tokenProgram:"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }),reason("incorrect_token_program"));
    assert.throws(() => build({ ...input(), rewardMint:null as unknown as PublicKeyInput }),reason("invalid_public_key"));
    assert.doesNotThrow(() => build({ ...input(), rewardMint:DEMO_MINT,tokenProgram:TOKEN_PROGRAM_ID }));
  });
}
test("funding derives accounts without accepting any caller-selected transfer amount", () => {
  const value: FundingInput = input(); const ix = fundMilestoneInstruction(value);
  assert.equal(ix.data.length,8); assert.equal(ix.keys.length,9);
  assert.equal(ix.keys[4]!.pubkey.toBase58(),deriveSponsorAta(value.sponsor).toBase58());
});
test("instructions compose into an unsigned wallet-adapter transaction without RPC or signing", () => {
  const value=input(), tx=new Transaction({ feePayer:new PublicKey(first.sponsor),recentBlockhash:first.pdas.internship[0] });
  tx.add(createInternshipInstruction(value),createMilestoneInstruction(value),fundMilestoneInstruction(value));
  assert.equal(tx.instructions.length,3);
  assert.ok(tx.serialize({ requireAllSignatures:false,verifySignatures:false }).length>0);
  assert.ok(tx.signatures.every(s=>s.signature===null));
});


test("accepts independently constructed PublicKey-like objects without constructor identity", () => {
  // Models a wallet-adapter key from a separate SDK copy with its own prototype.
  class ForeignPublicKey {
    constructor(private readonly address: string) {}
    toBytes(): Uint8Array { return new PublicKey(this.address).toBytes(); }
    toBase58(): string { return this.address; }
  }
  const sponsor = new ForeignPublicKey(first.sponsor), verifier = new ForeignPublicKey(first.verifier);
  assert.equal(sponsor instanceof PublicKey, false);
  const value = { ...input(), sponsor, verifier, rewardMint:new ForeignPublicKey(DEMO_MINT), tokenProgram:new ForeignPublicKey(TOKEN_PROGRAM_ID) };
  for (const [build, expected] of [[createInternshipInstruction, first.createInternship],
    [createMilestoneInstruction, first.createMilestone], [fundMilestoneInstruction, first.fundMilestone]] as const) {
    const ix = build(value);
    assert.equal(ix.data.toString("hex"), expected.dataHex);
    assert.deepEqual(ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),expected.accounts);
  }
  assert.equal(deriveSponsorAta(sponsor).toBase58(),first.pdas.sponsorAta);
});
for (const [name, value] of Object.entries({
  empty: {}, missingBytes: {toBase58:()=>first.sponsor}, missingBase58: {toBytes:()=>new Uint8Array(32)},
  nonCallable: {toBytes:32,toBase58:first.sponsor},
  shortBytes: {toBytes:()=>new Uint8Array(31),toBase58:()=>first.sponsor},
  longBytes: {toBytes:()=>new Uint8Array(33),toBase58:()=>first.sponsor},
  arrayBytes: {toBytes:()=>Array(32).fill(1),toBase58:()=>first.sponsor},
  stringBytes: {toBytes:()=>first.sponsor,toBase58:()=>first.sponsor},
  mismatched: {toBytes:()=>new PublicKey(first.sponsor).toBytes(),toBase58:()=>first.verifier},
  nonCanonical: {toBytes:()=>new PublicKey(first.sponsor).toBytes(),toBase58:()=>" " + first.sponsor},
  throwing: {toBytes:()=>{throw new Error("invalid key");},toBase58:()=>first.sponsor},
  nonStringBase58: {toBytes:()=>new PublicKey(first.sponsor).toBytes(),toBase58:()=>123}
})) {
  test("rejects malformed PublicKey-like object: " + name, () => {
    assert.throws(()=>createInternshipInstruction({...input(),sponsor:value as unknown as PublicKeyInput}),reason("invalid_public_key"));
  });
}
