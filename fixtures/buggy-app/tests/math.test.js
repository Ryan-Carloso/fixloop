import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.js";

test("add(2, 3) returns 5", () => {
  assert.equal(add(2, 3), 5);
});

test("add(-1, 1) returns 0", () => {
  assert.equal(add(-1, 1), 0);
});
