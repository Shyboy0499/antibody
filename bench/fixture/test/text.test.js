import assert from "node:assert/strict";
import { test } from "node:test";
import { titleCase } from "../src/text.js";

test("titles get a capital per word", () => {
  assert.equal(titleCase("blue MUG"), "Blue Mug");
});
