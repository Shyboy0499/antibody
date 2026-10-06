import assert from "node:assert/strict";
import { test } from "node:test";
import { toDecimal } from "../src/money.js";

test("cents become a decimal string", () => {
  assert.equal(toDecimal(1200), "12.00");
  assert.equal(toDecimal(5), "0.05");
});
