import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const rpc = "https://api.devnet.solana.com"; // Injected fetch only; no network.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
for (const directory of ["packages/finance-client", "services/verifier"]) {
  const require = createRequire(path.join(root, directory, "package.json"));
  const { Connection, PublicKey } = require("@solana/web3.js");
  const Client = require("jayson/lib/client/browser");
  test(directory + ": pinned SDK and scoped remediation", () => {
    assert.equal(require("@solana/web3.js/package.json").version, "1.98.4");
    assert.equal(require("jayson/package.json").version, "5.0.0");
    const selectedJayson = require("jayson/package.json");
    assert.equal(Object.hasOwn(selectedJayson.dependencies, "stream-json"), false);
    assert.equal(Object.hasOwn(selectedJayson.dependencies, "uuid"), false);
    const lock = JSON.parse(readFileSync(path.join(root, directory, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["node_modules/jayson"].version, "5.0.0");
    assert.ok(!Object.keys(lock.packages).some(name => name.endsWith("node_modules/stream-json")));
    assert.ok(!Object.entries(lock.packages).some(([name, entry]) =>
      name.endsWith("node_modules/uuid") && entry.version === "8.3.2"));
  });
  test(directory + ": Connection methods, params and unique UUID request IDs", async () => {
    const calls = [];
    const connection = new Connection(rpc, { commitment: "confirmed", disableRetryOnRateLimit: true,
      fetch: async (url, init) => {
        assert.equal(url, rpc);
        const request = JSON.parse(init.body);
        assert.equal(request.jsonrpc, "2.0"); assert.match(request.id, uuid); calls.push(request);
        const values = { getGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
          getMultipleAccounts: { context: { slot: 10 }, value: [null] },
          getMinimumBalanceForRentExemption: 2039280,
          getBalance: { context: { slot: 10 }, value: 1000 } };
        assert.ok(Object.hasOwn(values, request.method));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: values[request.method] }));
      } });
    assert.equal(await connection.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    assert.deepEqual(await connection.getMultipleAccountsInfo([PublicKey.default], "confirmed"), [null]);
    assert.equal(await connection.getMinimumBalanceForRentExemption(165, "confirmed"), 2039280);
    assert.equal(await connection.getBalance(PublicKey.default, "confirmed"), 1000);
    assert.equal(new Set(calls.map(c => c.id)).size, 4);
    assert.deepEqual(calls[1].params, [[PublicKey.default.toBase58()], { encoding: "base64", commitment: "confirmed" }]);
    assert.deepEqual(calls[2].params, [165, { commitment: "confirmed" }]);
  });
  test(directory + ": RPC error code, message and data preserved", async () => {
    const connection = new Connection(rpc, { fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        error: { code: -32000, message: "mock unavailable", data: { fixture: true } } }));
    } });
    await assert.rejects(connection.getGenesisHash(), e => {
      assert.equal(e.code, -32000); assert.match(e.message, /mock unavailable/);
      assert.deepEqual(e.data, { fixture: true }); return true;
    });
  });
  for (const failure of ["json", "schema", "http", "transport"]) {
    test(directory + ": " + failure + " failure rejects", async () => {
      const connection = new Connection(rpc, { disableRetryOnRateLimit: true, fetch: async (_url, init) => {
        if (failure === "transport") throw new Error("mock transport");
        if (failure === "json") return new Response("{");
        if (failure === "http") return new Response("mock unavailable", { status: 503, statusText: "Unavailable" });
        const request = JSON.parse(init.body);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 99 }));
      } });
      await assert.rejects(connection.getGenesisHash());
    });
  }
  test(directory + ": explicit IDs, custom generators and notifications", () => {
    const client = new Client(() => { throw Error("not dispatched"); }, { generator: () => "fixed" });
    assert.equal(client.request("fixture", [], 0).id, 0);
    assert.equal(client.request("fixture", [], "explicit").id, "explicit");
    assert.equal(client.request("fixture", []).id, "fixed");
    assert.equal(Object.hasOwn(client.request("fixture", [], null), "id"), false);
    const defaults = new Client(() => {});
    assert.match(defaults.request("fixture", []).id, uuid);
    assert.notEqual(defaults.request("fixture", []).id, defaults.request("fixture", []).id);
  });
  test(directory + ": Jayson callbacks preserve result/error/parse/transport behavior", async () => {
    const call = (response, error = null) => new Promise(resolve => {
      new Client((_request, callback) => callback(error, response))
        .request("fixture", [], "explicit", (err, value) => resolve({ err, value }));
    });
    assert.deepEqual((await call('{"jsonrpc":"2.0","id":"explicit","result":{"ok":true}}')).value.result, { ok: true });
    assert.equal((await call('{"jsonrpc":"2.0","id":"explicit","error":{"code":-1,"message":"fixture"}}')).value.error.code, -1);
    assert.ok((await call("{")).err instanceof SyntaxError);
    const error = new Error("transport"); assert.equal((await call("", error)).err, error);
  });
  test(directory + ": batch requests and three-argument callbacks", async () => {
    const client = new Client((wire, callback) => {
      const requests = JSON.parse(wire);
      assert.equal(requests.length, 2);
      callback(null, JSON.stringify([
        { jsonrpc: "2.0", id: requests[0].id, result: 7 },
        { jsonrpc: "2.0", id: requests[1].id, error: { code: -1, message: "fixture" } },
      ]));
    });
    const a = client.request("one", [], "a"), b = client.request("two", [], "b");
    await new Promise((resolve, reject) => client.request([a, b], (err, errors, results) => {
      try {
        assert.equal(err, null); assert.equal(errors[0].id, "b"); assert.equal(results[0].result, 7);
        resolve();
      } catch (error) { reject(error); }
    }));
  });

}
