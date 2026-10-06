import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal, lineTotal } from "../src/cart.js";

test("a line costs its product's price", () => {
  assert.equal(lineTotal({ productId: 1, quantity: 1 }), 1200);
});

test("a cart costs the sum of its lines", () => {
  assert.equal(
    cartTotal([
      { productId: 1, quantity: 1 },
      { productId: 3, quantity: 1 },
    ]),
    1500,
  );
});

test("an unknown product is an error", () => {
  assert.throws(
    () => lineTotal({ productId: 99, quantity: 1 }),
    /no product 99/,
  );
});
