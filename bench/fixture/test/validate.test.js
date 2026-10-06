import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmail } from "../src/validate.js";

test("an address needs an @", () => {
  assert.equal(isEmail("kim@shop.example"), true);
  assert.equal(isEmail("kim"), false);
});
