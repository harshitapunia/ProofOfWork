import assert from "node:assert/strict";
import { test } from "node:test";
import { sum } from "./passing.mjs";

test("sums bounded numbers and quarter increments without changing the input", () => {
  const values = Object.freeze([1.25, -2, 0.5, 0]);
  assert.equal(sum(values), -0.25);
  assert.equal(sum([]), 0);
  assert.equal(sum([2 ** 46, 0.25, -(2 ** 46), -0.5]), -0.25);
});

test("rejects malformed arrays instead of coercing or skipping entries", () => {
  for (const values of [[1, "2"], [1, NaN], [Infinity], Array(1), "12"]) {
    assert.throws(() => sum(values), TypeError);
  }
});
