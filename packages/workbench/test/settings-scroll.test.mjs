// The settings modal shows its content in the native modal, which reports the scroll position of the content; the position is
// negative while the content is pulled past its start (the overscroll of a trackpad). A position is a measurement and not a
// command, so it is kept as reported; only a value that is not a number is refused (docs/spec/settings.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("a negative scroll position of the settings modal is kept as reported and a value that is not a number is refused", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  let answer = null;
  const overlay = { show: (card, rect, handler) => { answer = handler; }, update: () => {}, place: () => {}, hide: () => {} };
  t.mock.module("../host.js", { exports: { ...await import("../host.js"), native: true, overlay } });
  t.mock.module("../compositor.js", { exports: { ...await import("../compositor.js"), standIn: () => {} } });
  t.mock.module("../environment.js", { exports: { pluginUnits: () => [] } });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js?scroll");
  try {
    ui.openSettings();
    assert.ok(answer, "the settings modal was not shown in the native modal");
    for (const reported of ["12", "-2", "-3.5", "0"]) {
      answer("scroll", reported);
      assert.equal(ui.settingsModalState().scroll, Number(reported), `the position ${reported} was not kept`);
    }
    for (const invalid of ["abc", "NaN", "Infinity", ""]) {
      assert.throws(() => answer("scroll", invalid), /settings scroll position is not a number/, invalid);
    }
  } finally {
    dom.window.close();
  }
});
