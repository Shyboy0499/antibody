import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./_module.js";

const { isEmail } = await load("src/validate.js");

test("isEmail wants a dot in the domain", () => {
  for (const good of ["a@b.co", "kim.lee@shop.example"])
    assert.equal(isEmail(good), true, good);
  for (const bad of ["a@b", "a@.co", "a@b.", "a b@c.de", "@b.co"])
    assert.equal(isEmail(bad), false, bad);
});
