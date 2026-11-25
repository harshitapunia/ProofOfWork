import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@solana/web3.js";
import { LifecycleStore } from "@proofwork/lifecycle";
import {
  PROGRAM_ID,
  DEMO_MINT,
  SETTLEMENT_DEVNET_GENESIS,
} from "@proofwork/finance-client";
import {
  approvalFile,
  parseApproval,
  ControlledActions,
  messageDigest,
  type RehearsalApproval,
} from "../src/controlled-actions.js";
// Only public configuration and disposable RAM signing keys. No operational signer files.
function configuration(): RehearsalApproval {
  return {
    version: "proofwork-controlled-devnet-v1",
    programId: PROGRAM_ID,
    mint: DEMO_MINT,
    genesis: SETTLEMENT_DEVNET_GENESIS,
    artifactSha256:
      "1711e2dbbd2f0129f34be5d70e3e48867c42a849b2beea7d36cfbddaf2ed64e1",
    upgradeAuthority: null,
    actions: [
      {
        id: "fixture",
        operationKey: "create_internship:fixture",
        scopeDigest: "ab".repeat(32),
        wallet: Keypair.generate().publicKey.toBase58(),
        additionalSigner: null,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        maxFeeLamports: 5000,
        maxRentLamports: 1000000,
      },
    ],
  };
}
test("private operator file is reloaded, rejects symlinks/permissions/foreign fields", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proofwork-approval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "approval.json"),
    c = configuration();
  writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
  const load = approvalFile(file);
  assert.deepEqual(await load(), c);
  chmodSync(file, 0o644);
  await assert.rejects(load());
  chmodSync(file, 0o600);
  symlinkSync(file, join(dir, "link"));
  await assert.rejects(approvalFile(join(dir, "link"))());
  writeFileSync(file, JSON.stringify({ ...c, actions: [] }));
  await assert.rejects(load());
  writeFileSync(file, JSON.stringify({ ...c, enableAll: true }));
  await assert.rejects(load());
});
for (const field of ["programId", "mint", "genesis", "artifactSha256"] as const)
  test("external identity mismatch refuses " + field, () => {
    const c = configuration();
    c[field] = "wrong";
    assert.throws(() => parseApproval(c));
  });
test("one-send fence survives reopen and refuses duplicate IDs, operation or approval reuse", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proofwork-one-send-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite"),
    config = configuration(),
    a = config.actions[0]!,
    message = Buffer.from("test-only message"),
    scope = {
      operationKey: a.operationKey,
      scopeDigest: a.scopeDigest,
      wallet: a.wallet,
      additionalSigner: null,
      fee: 5000,
      rent: 1000,
    };
  let store = new LifecycleStore(path),
    actions = new ControlledActions(
      store,
      async () => config,
      async () => {
        throw Error("timeout");
      }
    ),
    id = randomUUID();
  await actions.reserve(id, scope, message);
  const signature = (await import("../src/devnet-execution.js")).transactionId(
    Buffer.alloc(64, 1)
  );
  assert.equal(
    (
      await actions.send(
        id,
        scope,
        message,
        Buffer.from("offline wire"),
        signature
      )
    ).state,
    "unknown"
  );
  store.close();
  store = new LifecycleStore(path);
  t.after(() => store.close());
  let calls = 0;
  actions = new ControlledActions(
    store,
    async () => config,
    async () => {
      calls++;
      throw Error();
    }
  );
  await assert.rejects(
    actions.send(id, scope, message, Buffer.from("offline wire"), signature)
  );
  await assert.rejects(actions.reserve(randomUUID(), scope, message));
  assert.equal(calls, 0);
  assert.equal(store.applicationTransactions.get(id)!.sendReserved, true);
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  assert.throws(() =>
    raw.prepare("DELETE FROM application_transactions WHERE id=?").run(id)
  );
  assert.throws(() =>
    raw
      .prepare("UPDATE application_transactions SET send_reserved=0 WHERE id=?")
      .run(id)
  );
  assert.equal(
    store.applicationTransactions.get(id)!.messageDigest,
    messageDigest(message)
  );
});
test("concurrent duplicate submission invokes transport at most once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proofwork-duplicate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new LifecycleStore(join(dir, "ledger.sqlite"));
  t.after(() => store.close());
  const c = configuration(),
    a = c.actions[0]!,
    scope = {
      operationKey: a.operationKey,
      scopeDigest: a.scopeDigest,
      wallet: a.wallet,
      additionalSigner: null,
      fee: 5000,
      rent: 0,
    };
  let calls = 0;
  const actions = new ControlledActions(
      store,
      async () => c,
      async () => {
        calls++;
        throw Error();
      }
    ),
    id = randomUUID(),
    message = Buffer.from("public message"),
    sig = (await import("../src/devnet-execution.js")).transactionId(
      Buffer.alloc(64, 1)
    );
  await actions.reserve(id, scope, message);
  await Promise.allSettled([
    actions.send(id, scope, message, Buffer.alloc(1), sig),
    actions.send(id, scope, message, Buffer.alloc(1), sig),
  ]);
  assert.equal(calls, 1);
  assert.equal(store.applicationTransactions.get(id)!.state, "unknown");
});

test("replacement approval ID cannot authorize a transaction reserved under the previous approval",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"proofwork-replaced-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new LifecycleStore(join(dir,"ledger.sqlite"));t.after(()=>store.close());const c=configuration(),a=c.actions[0]!,scope={operationKey:a.operationKey,scopeDigest:a.scopeDigest,wallet:a.wallet,additionalSigner:null,fee:5000,rent:0};let loads=0,calls=0;
 const actions=new ControlledActions(store,async()=>{loads++;return loads>=3?{...c,actions:[{...a,id:"replacement"}]}:c;},async()=>{calls++;throw Error();}),id=randomUUID(),message=Buffer.from("public message"),sig=(await import("../src/devnet-execution.js")).transactionId(Buffer.alloc(64,1));await actions.reserve(id,scope,message);await assert.rejects(actions.send(id,scope,message,Buffer.alloc(1),sig),{code:"approval_replaced"});assert.equal(calls,0);assert.equal(store.applicationTransactions.get(id)!.sendReserved,false);
});
for(const transportFails of [false,true])test("confirmation racing a pending RPC response retains the terminal result: failure="+transportFails,async t=>{
 const dir=mkdtempSync(join(tmpdir(),"proofwork-confirm-race-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new LifecycleStore(join(dir,"ledger.sqlite"));t.after(()=>store.close());const c=configuration(),a=c.actions[0]!,scope={operationKey:a.operationKey,scopeDigest:a.scopeDigest,wallet:a.wallet,additionalSigner:null,fee:5000,rent:0};let release!:()=>void,started!:()=>void,calls=0;const gate=new Promise<void>(resolve=>release=resolve),began=new Promise<void>(resolve=>started=resolve),sig=(await import("../src/devnet-execution.js")).transactionId(Buffer.alloc(64,1));
 const actions=new ControlledActions(store,async()=>c,async()=>{calls++;started();await gate;if(transportFails)throw Error("lost response");return Response.json({jsonrpc:"2.0",id:"controlled-send",result:sig});}),id=randomUUID(),message=Buffer.from("public message");await actions.reserve(id,scope,message);const pending=actions.send(id,scope,message,Buffer.alloc(1),sig);await began;assert.equal(actions.recordConfirmation(id,sig,"confirmed"),"confirmed");release();assert.equal((await pending).state,"submitted");assert.equal(actions.recordConfirmation(id,sig,"unknown"),"confirmed");assert.equal(store.applicationTransactions.get(id)!.state,"confirmed");assert.equal(calls,1);
});
