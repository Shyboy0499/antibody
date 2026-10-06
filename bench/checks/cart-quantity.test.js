import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./_module.js";

const { cartTotal } = await load("src/cart.js");

test("cartTotal counts quantities", () => {
  assert.equal(
    cartTotal([
      { productId: 1, quantity: 3 },
      { productId: 3, quantity: 2 },
    ]),
    4200,
  );
  assert.equal(cartTotal([{ productId: 2 }]), 2500);
});
