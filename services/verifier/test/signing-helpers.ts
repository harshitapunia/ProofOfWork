/** Ephemeral cryptography TEST FIXTURE ONLY. Never imported from src or runtime routes. */
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { fixture, githubFetch } from "./helpers.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { VerifierService } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { CASES } from "../src/manifest.js";
import { AttestationAuthorizer, buildAttestMilestoneInstruction } from "../src/attestation.js";
import { AttestationTransactionPolicy } from "../src/transaction-policy.js";
import { OfflineDualSignatureSimulation, takeOfflineRoleMessage, type OfflineRoleRequest,
  type SimulationRole, type EphemeralRoleSimulation } from "../src/offline-signature-simulation.js";
export function barrier() {
  let release!: () => void, arrive!: () => void;
  const entered = new Promise<void>(r => { arrive = r; }), pending = new Promise<void>(r => { release = r; });
  return { entered, release, wait: async () => { arrive(); await pending; } };
}
export function ephemeral(role: SimulationRole) {
  const pair = generateKeyPairSync("ed25519"); // No export of private key material, env loading or filesystem writes.
  const publicKey = new PublicKey(pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toBase58();
  let before = async (_request: OfflineRoleRequest) => {}, after = async (_message: Buffer, _signature: Buffer) => {};
  let response = (signature: Buffer, _message: Buffer): Uint8Array => signature;
  const messages: Buffer[] = [], signatures: Buffer[] = [], tokens: OfflineRoleRequest[] = [];
  const provider: EphemeralRoleSimulation = { mode: "ephemeral-offline-test", publicKey,
    simulateAttestation: async request => {
      tokens.push(request); await before(request);
      const message = takeOfflineRoleMessage(request, role, publicKey);
      const signature = sign(null, message, pair.privateKey);
      messages.push(Buffer.from(message)); signatures.push(Buffer.from(signature));
      await after(message, signature);
      return response(signature, message);
    } };
  return { provider, publicKey, messages, signatures, tokens,
    before: (fn: typeof before) => { before = fn; }, after: (fn: typeof after) => { after = fn; },
    response: (fn: typeof response) => { response = fn; },
    // Negative/local crypto tests only; this function is not shipped in src.
    signForTest: (message: Uint8Array) => sign(null, message, pair.privateKey),
    verifies: (message: Uint8Array, signature: Uint8Array) => verify(null, message, pair.publicKey, signature) };
}
export async function signingFixture() {
  const f = fixture(), verifier = ephemeral("verifier"), payer = ephemeral("fee_payer");
  new PublicKey(verifier.publicKey).toBuffer().copy(f.m, 104);
  const reader = new DevnetAttestationReader("https://api.devnet.solana.com", verifier.publicKey, f.rpc);
  let time = 0, reads = 0, blockReads = 0, runs = 0;
  let onChain = async (_n: number) => {}, onBlock = async (_n: number) => {}, onRun = async () => {};
  const chain = { read: async (id: string) => { await onChain(++reads); return reader.read(id); } };
  const service = new VerifierService(new GitHub(githubFetch()), chain, { run: async () => {
    runs++; await onRun(); return CASES.map(c => ({ id: c.id, passed: true }));
  } });
  const now = () => time;
  const config = { verifier: verifier.publicKey, feePayer: payer.publicKey, maxAgeMs: 5000, minRemainingBlockHeights: 10 };
  const observation = { rpc: "https://api.devnet.solana.com" as const, genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(), lastValidBlockHeight: 200,
    currentBlockHeight: 100, observedAtMs: 0, valid: true };
  const source = { read: async () => { await onBlock(++blockReads); return { ...observation }; } };
  const authorizer = new AttestationAuthorizer(service, chain, config.verifier, now);
  const policy = new AttestationTransactionPolicy(authorizer, chain, source, config, now);
  const state = await reader.read(f.request.milestone);
  const transaction = () => new Transaction({ feePayer: new PublicKey(config.feePayer), recentBlockhash: observation.blockhash })
    .add(buildAttestMilestoneInstruction(state, config.verifier));
  const simulator = (timeout = 1000) => new OfflineDualSignatureSimulation(verifier.provider, payer.provider, now, timeout);
  return { ...f, verifier, payer, chain, source, service, config, observation, authorizer, policy, transaction, simulator, now,
    expected: transaction().serializeMessage(), state, runs: () => runs,
    clock: (n: number) => { time = n; }, onChain: (fn: typeof onChain) => { onChain = fn; },
    onBlock: (fn: typeof onBlock) => { onBlock = fn; }, onRun: (fn: typeof onRun) => { onRun = fn; } };
}
