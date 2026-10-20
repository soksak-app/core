// The answer of a native modal that the page receives is written as the page trace event `page.trace.modal.answer` with its key, at
// the receipt (docs/spec/performance-trace.md#producers). The overlay document has no trace switch, so the main page writes the event.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

const listeners = {};
mock.module("@soksak/runtime", { namedExports: { host: {
  on: (name, listener) => { listeners[name] = listener; return Promise.resolve(() => {}); },
  page: (path) => path,
  call: async () => {},
  reload: () => {},
} } });

// The trace calls of the page are recorded: the event name and its fields are what the trace writes.
const traced = [];
const actualPerformance = await import("../performance.js");
mock.module("../performance.js", { namedExports: {
  ...actualPerformance,
  trace: (event, fields = {}) => { traced.push({ event, fields }); },
} });
const { overlay } = await import("../host.js");

test("an answer that reaches the receiver of a modal is traced as modal.answer with its key", () => {
  const el = document.getElementById("menu");
  const picked = [];
  overlay.show(el, { x: 0, y: 0, w: 10, h: 10 }, (key, value) => picked.push([key, value]));
  traced.length = 0;
  listeners["overlay-pick"]({ id: "menu", key: "core.modal.dismiss", value: "" });
  assert.deepEqual(picked, [["core.modal.dismiss", ""]]);
  assert.deepEqual(traced, [{ event: "modal.answer", fields: { key: "core.modal.dismiss" } }]);
});

test("a state report of the modal document is not an answer and is not traced", () => {
  const el = document.getElementById("menu");
  overlay.show(el, { x: 0, y: 0, w: 10, h: 10 }, () => {});
  traced.length = 0;
  listeners["overlay-pick"]({ id: "menu", key: "document", value: "{}" });
  assert.deepEqual(traced, []);
});
