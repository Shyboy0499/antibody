import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./_module.js";

const { cartTotal } = await load("src/cart.js");

test("discount codes", () => {
  const poster = [{ productId: 2, quantity: 1 }];
  assert.equal(cartTotal(poster), 2500);
  assert.equal(cartTotal(poster, "SAVE10"), 2250);
  assert.equal(cartTotal([{ productId: 3, quantity: 1 }], "SAVE10"), 270);
  assert.throws(() => cartTotal(poster, "BOGUS"), /BOGUS/);
});
