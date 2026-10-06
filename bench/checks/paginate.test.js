import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./_module.js";

const { paginate } = await load("src/list.js");

test("paginate", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(paginate(items, 1, 2), {
    items: [1, 2],
    page: 1,
    pages: 3,
    total: 5,
  });
  assert.deepEqual(paginate(items, 3, 2), {
    items: [5],
    page: 3,
    pages: 3,
    total: 5,
  });
  assert.deepEqual(paginate(items, 4, 2), {
    items: [],
    page: 4,
    pages: 3,
    total: 5,
  });
  assert.equal(paginate(items, 1).items.length, 5);
});
