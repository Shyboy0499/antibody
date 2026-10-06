import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./_module.js";

const { start } = await load("src/server.js");

test("GET /health", async () => {
  const server = await start(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});
