import assert from "node:assert/strict";
import { test } from "node:test";
import { sortBy } from "../src/list.js";

test("lists sort by a key without changing the original", () => {
  const items = [{ n: 2 }, { n: 1 }];
  assert.deepEqual(sortBy(items, "n"), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(items, [{ n: 2 }, { n: 1 }]);
});
