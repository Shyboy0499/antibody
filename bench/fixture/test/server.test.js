import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "../src/server.js";

test("the API totals a cart", async () => {
  const server = await start();
  try {
    const { port } = server.address();
    const res = await fetch(`http://localhost:${port}/cart/total`, {
      method: "POST",
      body: JSON.stringify({ lines: [{ productId: 2, quantity: 1 }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { totalCents: 2500 });
  } finally {
    server.close();
  }
});
