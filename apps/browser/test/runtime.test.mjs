import assert from "node:assert/strict";
import test from "node:test";
import * as runtime from "../runtime/index.js";

test("the browser runtime has no native host and opens a browser store", () => {
  assert.equal(runtime.host, null);
  assert.equal(runtime.page, null);
  assert.equal(typeof runtime.openStore, "function");
});

test("the browser start document lists no pending image detach", { timeout: 5000 }, async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  globalThis.indexedDB = new IDBFactory();
  const { default: start } = await import("../runtime/start.js");
  // A browser tab has no host image regions, so no surface waits for an image detach (docs/spec/sidecars.md).
  assert.deepEqual(start.pendingSurfaces, []);
  assert.equal(start.controls, null);
});
