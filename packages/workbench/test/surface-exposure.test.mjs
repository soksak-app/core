import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { registerSurfaceExposure } from "../surface-exposure.js";

// core.surface.document 의 body 는 표면 내용의 크기, viewport 는 보이는 자리다(docs/spec/exposure.md).
// jsdom 은 배치를 계산하지 않으므로 호스트의 상자와 스크롤 크기를 정해 둔다.
function documentOf({ width, height, scrollWidth, clientWidth, scrollHeight, clientHeight }) {
  const dom = new JSDOM("<main><div id=host></div></main>", { url: "http://localhost/" });
  const host = dom.window.document.querySelector("#host");
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
  for (const [name, value] of Object.entries({ scrollWidth, clientWidth, scrollHeight, clientHeight })) {
    Object.defineProperty(host, name, { value });
  }
  const root = host.attachShadow({ mode: "open" });
  const reads = new Map();
  const expose = { status: async (name, read) => { reads.set(name, read); }, command: async () => {}, audit: () => [] };
  const exposure = registerSurfaceExposure({ root, expose, view: dom.window });
  const doc = reads.get("core.surface.document")();
  exposure.dispose();
  dom.window.close();
  return doc;
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

test("surface exposure requires a shadow root and its view instead of substituting values", () => {
  const expose = { status: async () => {}, command: async () => {}, audit: () => [] };
  const dom = new JSDOM("<div></div>");
  assert.throws(() => registerSurfaceExposure({ root: dom.window.document.body, expose, view: dom.window }), /shadow root/);
  const root = dom.window.document.querySelector("div").attachShadow({ mode: "open" });
  assert.throws(() => registerSurfaceExposure({ root, expose }), /view/);
  dom.window.close();
});
