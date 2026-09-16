import assert from "node:assert/strict";
import test from "node:test";
import * as runtime from "../runtime/index.js";

test("the browser runtime has no native host and opens a browser store", () => {
  assert.equal(runtime.host, null);
  assert.equal(runtime.page, null);
  assert.equal(typeof runtime.openStore, "function");
});
