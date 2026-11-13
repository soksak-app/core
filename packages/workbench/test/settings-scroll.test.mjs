// The settings modal shows its content in the native modal, which reports the scroll position of the content; the position is negative while the content is pulled past its start (the overscroll of a trackpad). A position is a measurement and not a
// command, so it is kept as reported; only a value that is not a number is refused (docs/spec/settings.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

test("a negative scroll position of the settings modal is kept as reported and a value that is not a number is refused", async () => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  // The host module reads the host wire when it is imported, so the case is selected before the first import of the page modules.
  const wire = selectPageWire("settings-scroll-modal");
  // The border of the card is the computed color of a style sheet, which the card takes from the document.
  const style = document.createElement("style");
  style.textContent = ".set-card {border-top-color: rgb(1, 2, 3); background-color: rgb(4, 5, 6);}";
  document.head.append(style);
  // jsdom has no adoptedStyleSheets, which the page reads when a style sheet exists; no sheet is adopted here.
  document.adoptedStyleSheets = [];
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js?scroll");
  const { orderedCallsAnswered } = await import("../host.js");
  try {
    ui.openSettings();
    await orderedCallsAnswered();
    assert.ok(wire.calls.some(({ name, payload }) => name === "overlayShow" && payload.id === "settings"),
      "the settings modal was not shown in the native modal");
    for (const reported of ["12", "-2", "-3.5", "0"]) {
      wire.deliverNotice();
      assert.equal(ui.settingsModalState().scroll, Number(reported), `the position ${reported} was not kept`);
    }
    for (const invalid of ["abc", "NaN", "Infinity", ""]) {
      assert.throws(() => wire.deliverNotice(), /settings scroll position is not a number/, invalid);
    }
    wire.finish();
  } finally {
    dom.window.close();
  }
});
