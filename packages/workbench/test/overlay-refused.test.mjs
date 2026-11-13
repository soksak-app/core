// A modal is open from show(), and a refusal of its overlayShow closes it in the turn of the answer when it is still the modal on display, then calls refused(reason) so its owner closes its layer (docs/spec/native-modals.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The menu and the dialog state the border colour, background and corner radius that the modal document is drawn with (host.js drawing reads them).
const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu" style="border-top-color: rgb(7, 8, 9); background-color: rgb(255, 255, 255); border-top-left-radius: 4px"></div>'
  + '<div id="dialog" data-native-modal="dialog" aria-label="Dialog" style="border-top-color: rgb(1, 2, 3); background-color: rgb(255, 255, 255)"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// The workbench page places a menu against its plane and a dialog over the whole page.
globalThis.innerWidth = dom.window.innerWidth;
globalThis.innerHeight = dom.window.innerHeight;

// The host calls of the page are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). The case of the
// first test is selected before the host module is imported, because the module reads the host when it is imported.
let wire = selectPageWire("overlay-refused-close");
const { modalState, orderedCallsAnswered, overlay } = await import("../host.js");

const rect = { x: 0, y: 0, w: 10, h: 10 };
// Lets the page send the calls that it queued in the current turn; every reply of the case is answered in the microtask queue.
const settled = () => new Promise((resolve) => setImmediate(resolve));
// The names of the calls of the page in the order it sent them, without the calls of the application log.
const names = () => wire.calls.map(({ name }) => name).filter((name) => name !== "log");

test("a refused overlayShow closes the modal it showed and calls refused with the reason", async () => {
  const refusals = [];
  overlay.show(document.getElementById("menu"), rect, () => {}, (reason) => refusals.push([reason.message, modalState()]));
  assert.equal(modalState()?.id, "menu", "the modal is open from show()");
  await settled();
  assert.deepEqual(wire.calls.map(({ name }) => name), ["overlayShow"]);
  wire.release();
  await settled();
  assert.equal(modalState(), null, "core.modal still names the modal whose show the host refused");
  assert.deepEqual(refusals, [["create modal webview: refused", null]], "refused ran once, after the modal closed");
  assert.deepEqual(names(), ["overlayShow", "overlayHide"], "the refused modal closes as hide() does");
  wire.finish();
});

test("a refusal of a modal that another show replaced changes nothing", async () => {
  wire = selectPageWire("overlay-refused-replaced");
  const refusals = [];
  overlay.show(document.getElementById("menu"), rect, () => {}, (reason) => refusals.push(reason.message));
  overlay.show(document.getElementById("dialog"), rect, () => {}, (reason) => refusals.push(reason.message));
  await settled();
  assert.deepEqual(names(), ["overlayShow"]);
  wire.release();
  await settled();
  assert.equal(modalState()?.id, "dialog", "the refusal of the replaced modal closed the one on display");
  assert.deepEqual(refusals, []);
  // The replaced modal hides, and the show of the dialog is the call after that answer.
  assert.deepEqual(names(), ["overlayShow", "overlayHide"]);
  wire.release();
  await settled();
  assert.deepEqual(names(), ["overlayShow", "overlayHide", "overlayShow"]);
  overlay.hide();
  await settled();
  await orderedCallsAnswered();
  assert.deepEqual(names(), ["overlayShow", "overlayHide", "overlayShow", "overlayHide"]);
  wire.finish();
});
