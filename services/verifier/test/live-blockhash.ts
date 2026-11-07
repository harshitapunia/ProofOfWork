import assert from "node:assert/strict";
import { DevnetBlockhashSource, BlockhashSourceError, DEVNET_GENESIS, DEVNET_RPC } from "../src/devnet-blockhash.js";

if (process.env.LIVE_DEVNET_BLOCKHASH !== "1") {
  console.log("SKIPPED: Set LIVE_DEVNET_BLOCKHASH=1 for read-only Devnet blockhash validation; no RPC calls made.");
} else {
  try {
    const source = new DevnetBlockhashSource();
    const first = await source.read(), second = await source.read();
    assert.equal(first.rpc, DEVNET_RPC); assert.equal(first.genesisHash, DEVNET_GENESIS);
    assert.equal(first.valid, true); assert.equal(second.valid, true);
    assert.equal(second.blockhash, first.blockhash);
    assert.equal(second.lastValidBlockHeight, first.lastValidBlockHeight);
    assert.ok(second.currentBlockHeight >= first.currentBlockHeight);
    assert.ok(second.currentBlockHeight < second.lastValidBlockHeight);
    assert.ok(second.observedAtMs >= first.observedAtMs && performance.now() >= second.observedAtMs);
    console.log("PASS: Real Devnet genesis, blockhash lease, validity, height and monotonic observations; no wallets or transactions.");
    console.log(JSON.stringify(second));
  } catch (error) {
    console.error("FAIL: Live blockhash validation: " + (error instanceof BlockhashSourceError ? error.code : "assertion_failure"));
    process.exitCode = 1;
  }
}
