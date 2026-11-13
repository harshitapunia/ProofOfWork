import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/finance-client/package.json", import.meta.url));
const { PublicKey } = require("@solana/web3.js");
const nodeFinance = await import("../../packages/finance-client/dist/src/index.js");
function publicFixture(tag) {
  for (let n = tag; n < 256; n++) {
    const key = new PublicKey(new Uint8Array(32).fill(n));
    if (PublicKey.isOnCurve(key.toBytes())) return key.toBase58();
  }
  throw Error("no public fixture");
}
function instructionView(ix) {
  return { programId: ix.programId.toBase58(), data: Buffer.from(ix.data).toString("hex"),
    keys: Array.from(ix.keys, k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]) };
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const rpc = "https://api.devnet.solana.com";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function bundle(directory, includeFinance) {
  const result = await build({
    stdin: { contents: 'import { Connection } from "@solana/web3.js"; import Client from "jayson/lib/client/browser";'
      + (includeFinance ? 'import * as finance from "./dist/src/index.js";' : "")
      + 'globalThis.compatibility = { Connection, Client' + (includeFinance ? ", finance" : "") + " };",
      resolveDir: root + directory, sourcefile: "browser-compatibility-entry.js" },
    bundle: true, platform: "browser", format: "iife", write: false, metafile: true,
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  assert.ok(Object.keys(result.metafile.inputs).some(p => p.includes("jayson/lib/generateId.js")));
  assert.ok(!Object.keys(result.metafile.inputs).some(p => /stream-json|node_modules\/uuid\//.test(p)));
  return result.outputFiles[0].text;
}
for (const directory of ["packages/finance-client", "services/verifier"]) {
  for (const mode of ["randomUUID", "getRandomValues"]) {
    test(directory + ": browser bundle mocked RPC with " + mode, async () => {
      const source = await bundle(directory, directory.includes("finance"));
      const ids = [];
      const context = vm.createContext({
        console, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
        crypto: mode === "randomUUID" ? webcrypto : { getRandomValues: a => webcrypto.getRandomValues(a) },
        fetch: async (_url, init) => {
          const request = JSON.parse(init.body); ids.push(request.id);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id,
            result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }));
        },
      });
      vm.runInContext(source, context, { timeout: 10000 });
      const { Connection, Client, finance } = context.compatibility;
      assert.match(new Client(() => {}).request("fixture", []).id, uuid);
      const connection = new Connection(rpc, { disableRetryOnRateLimit: true });
      assert.equal(await connection.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
      assert.match(ids[0], uuid);
      assert.equal(vm.runInContext("typeof require", context), "undefined");
      assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
      if (finance) {
        const input = { sponsor: publicFixture(1), student: publicFixture(70), caller: publicFixture(210),
          internshipId: 1n, milestoneId: 2n };
        assert.deepEqual(instructionView(finance.settleMilestoneInstruction(input)),
          instructionView(nodeFinance.settleMilestoneInstruction(input)));
      }
    });
  }
}
test("browser without Web Crypto fails closed; explicit ID generator works", async () => {
  const context = vm.createContext({ console, TextEncoder, TextDecoder, URL, URLSearchParams, setTimeout, clearTimeout });
  vm.runInContext(await bundle("packages/finance-client", true), context, { timeout: 10000 });
  const { Client } = context.compatibility;
  assert.throws(() => new Client(() => {}).request("fixture", []), /crypto/);
  assert.equal(new Client(() => {}, { generator: () => "explicit" }).request("fixture", []).id, "explicit");
});
