import assert from "node:assert/strict";
import test from "node:test";

import { registerSurfaceExposure } from "../surface-exposure.js";

// core.surface.document 의 body 는 표면 내용의 크기, viewport 는 보이는 자리다(docs/spec/exposure.md).
function documentOf({ width, height, scrollWidth, clientWidth, scrollHeight, clientHeight }) {
  const reads = new Map();
  const host = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    scrollWidth, clientWidth, scrollHeight, clientHeight,
    ownerDocument: { readyState: "complete", documentElement: {} },
  };
  const root = { host, addEventListener() {}, removeEventListener() {} };
  const expose = {
    status: async (name, read) => { reads.set(name, read); },
    command: async () => {},
    audit: () => [],
  };
  registerSurfaceExposure({ root, expose, view: { getComputedStyle: () => null, location: { href: "" }, performance: { timeOrigin: 0 }, devicePixelRatio: 1 } });
  return reads.get("core.surface.document")();
}

test("a surface whose content fits reports the same body and viewport", () => {
  const doc = documentOf({ width: 558, height: 286.5, scrollWidth: 558, clientWidth: 558, scrollHeight: 287, clientHeight: 287 });
  assert.deepEqual([doc.body, doc.viewport], [{ width: 558, height: 286.5 }, { width: 558, height: 286.5 }]);
});

test("a surface whose content overflows reports a body larger than its viewport", () => {
  const doc = documentOf({ width: 100.5, height: 50, scrollWidth: 180, clientWidth: 100, scrollHeight: 90, clientHeight: 50 });
  assert.deepEqual(doc.viewport, { width: 100.5, height: 50 });
  assert.deepEqual(doc.body, { width: 180.5, height: 90 });
});
