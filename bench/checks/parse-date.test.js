import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./_module.js";

const { parseDate } = await load("src/dates.js");

test("parseDate", () => {
  assert.equal(
    parseDate("2026-10-06")?.toISOString(),
    "2026-10-06T00:00:00.000Z",
  );
  assert.equal(
    parseDate("2024-02-29")?.toISOString(),
    "2024-02-29T00:00:00.000Z",
  );
  for (const bad of [
    "2026-02-30",
    "2026-13-01",
    "26-1-1",
    "2026-1-01",
    "",
    "soon",
  ])
    assert.equal(parseDate(bad), null, bad);
});
