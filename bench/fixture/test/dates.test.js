import assert from "node:assert/strict";
import { test } from "node:test";
import { today } from "../src/dates.js";

test("today is a YYYY-MM-DD string", () => {
  assert.equal(today(new Date("2026-03-04T10:00:00Z")), "2026-03-04");
});
