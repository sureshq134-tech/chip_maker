const test = require("node:test");
const assert = require("node:assert/strict");

test("Node runtime provides fetch and AbortSignal.timeout", () => {
  assert.equal(typeof fetch, "function");
  assert.equal(typeof AbortSignal.timeout, "function");
});
