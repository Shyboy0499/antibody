import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./_module.js";

const { formatPrice } = await load("src/money.js");

test("formatPrice", () => {
  assert.equal(formatPrice(1200, "USD"), "$12.00");
  assert.equal(formatPrice(1200, "EUR"), "€12.00");
  assert.equal(formatPrice(5, "GBP"), "£0.05");
  assert.equal(formatPrice(-300, "USD"), "-$3.00");
  assert.equal(formatPrice(1200), "$12.00");
});
