// An update whose copy equals the copy the host last received for the shown modal sends nothing, and an update of a changed copy sends one (docs/spec/native-modals.md#usage).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The menu states the border colour, background and corner radius that the modal document is drawn with (host.js drawing reads them).
const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu" style="border-top-color: rgb(7, 8, 9); background-color: rgb(255, 255, 255); border-top-left-radius: 4px"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = dom.window.innerWidth;
globalThis.innerHeight = dom.window.innerHeight;

// The host calls of the page are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md). The case is selected
// before the host module is imported, because the module reads the host when it is imported.
const wire = selectPageWire("overlay-update-unchanged");
const { overlay } = await import("../host.js");

const rect = { x: 0, y: 0, w: 1024, h: 768 };
// Lets the page send the calls that it queued in the current turn; every reply of the case is answered in the microtask queue.
const settled = () => new Promise((resolve) => setImmediate(resolve));
// The names of the calls of the page in the order it sent them, without the calls of the application log.
const names = () => wire.calls.map(({ name }) => name).filter((name) => name !== "log");

test("an update of the copy that the host received sends nothing, and an update of a changed copy sends one", async () => {
  const menu = document.getElementById("menu");
  overlay.show(menu, rect, () => {}, () => {});
  await settled();
  assert.deepEqual(names(), ["overlayShow"], "show sends the modal");
  overlay.update(menu);
  await settled();
  assert.deepEqual(names(), ["overlayShow"], "an update of the copy that the host received is not sent");
  menu.innerHTML = "<p>Changed</p>";
  overlay.update(menu);
  await settled();
  assert.deepEqual(names(), ["overlayShow", "overlayUpdate"], "an update of a changed copy is sent once");
  overlay.hide(menu);
  await settled();
  assert.deepEqual(names(), ["overlayShow", "overlayUpdate", "overlayHide"]);
  wire.finish();
});
