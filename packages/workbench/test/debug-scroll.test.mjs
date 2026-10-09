// The native modal reports the scroll position of its content, which is negative while the content is pulled past its start
// (the overscroll of a trackpad). A position is a measurement and not a command, so it is kept as reported; only a value that
// is not a number is refused (docs/spec/debug.md).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("a negative scroll position of the native modal is kept as reported and a value that is not a number is refused", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>");
  globalThis.document = dom.window.document;
  globalThis.CSS = { escape: (value) => value };
  let answer = null;
  const overlay = { show: (card, rect, handler) => { answer = handler; }, update: () => {}, place: () => {}, hide: () => {} };
  t.mock.module("../host.js", { namedExports: {
    native: true,
    debug: { record: async () => ({ path: "logs/state.json" }), files: async () => [], read: async () => ({}), save: async () => {}, saveAll: async () => {} },
    overlay,
  } });
  t.mock.module("../compositor.js", { namedExports: { standIn: () => {} } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  t.mock.module("../commands.js", { namedExports: { commandOf: () => null, delegate: () => {}, mark: () => {}, run: async () => {} } });
  t.mock.module("../exposure.js", { namedExports: { registry: { list: () => ({ status: [] }), registrants: () => [], handle: async () => ({}) } } });
  t.mock.module("../shown-errors.js", { namedExports: { hideError: () => {}, showError: () => {} } });
  const { closeDebug, debugState, openDebug } = await import("../debug-ui.js?scroll");
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0 });
  await openDebug();
  try {
    for (const reported of ["12", "-1", "-3.5", "0"]) {
      answer("scroll", reported);
      assert.equal(debugState().scroll, Number(reported), `the position ${reported} was not kept`);
    }
    for (const invalid of ["abc", "NaN", "Infinity", ""]) {
      assert.throws(() => answer("scroll", invalid), /debug scroll position is not a number/, invalid);
    }
  } finally {
    closeDebug();
    dom.window.close();
  }
});
