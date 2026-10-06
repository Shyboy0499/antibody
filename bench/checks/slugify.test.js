import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./_module.js";

const { slugify } = await load("src/text.js");

test("slugify", () => {
  assert.equal(slugify("Café Crème — Large!"), "cafe-creme-large");
  assert.equal(slugify("  Hello   World  "), "hello-world");
  assert.equal(slugify("A/B 2 Pack"), "a-b-2-pack");
  assert.equal(slugify("---"), "");
});
