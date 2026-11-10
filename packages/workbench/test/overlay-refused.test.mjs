// A modal is open from show(), and a refusal of its overlayShow closes it in the turn of the answer when it is still the modal on
// display, then calls refused(reason) so its owner closes its layer (docs/spec/native-modals.md).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu"></div>'
  + '<div id="dialog" data-native-modal="dialog" aria-label="Dialog"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// The workbench page places a menu against its plane and a dialog over the whole page.
globalThis.innerWidth = dom.window.innerWidth;
globalThis.innerHeight = dom.window.innerHeight;

// The host answers each ordered call when the test lets it, and answers the application log at once.
const pending = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => Promise.resolve(() => {}),
  page: (path) => path,
  call: (name, request) => name === "log"
    ? Promise.resolve(request.action === "clock" ? { ts_us: 1, mono_ns: 1 } : undefined)
    : new Promise((resolve, reject) => pending.push({ name, request, resolve, reject })),
  reload: () => {},
} } });
const { modalState, orderedCallsAnswered, overlay } = await import("../host.js");

// Lets the ordered calls that wait be sent.
const turns = () => new Promise((resolve) => setTimeout(resolve, 0));
const rect = { x: 0, y: 0, w: 10, h: 10 };

test("a refused overlayShow closes the modal it showed and calls refused with the reason", async () => {
  const refusals = [];
  overlay.show(document.getElementById("menu"), rect, () => {}, (reason) => refusals.push([reason.message, modalState()]));
  assert.equal(modalState()?.id, "menu", "the modal is open from show()");
  await turns();
  assert.deepEqual(pending.map((call) => call.name), ["overlayShow"]);
  pending.shift().reject(new Error("create modal webview: refused"));
  await turns();
  assert.equal(modalState(), null, "core.modal still names the modal whose show the host refused");
  assert.deepEqual(refusals, [["create modal webview: refused", null]], "refused ran once, after the modal closed");
  assert.deepEqual(pending.map((call) => call.name), ["overlayHide"], "the refused modal closes as hide() does");
  pending.shift().resolve();
  await orderedCallsAnswered();
});

test("a refusal of a modal that another show replaced changes nothing", async () => {
  const refusals = [];
  overlay.show(document.getElementById("menu"), rect, () => {}, (reason) => refusals.push(reason.message));
  overlay.show(document.getElementById("dialog"), rect, () => {}, (reason) => refusals.push(reason.message));
  await turns();
  assert.deepEqual(pending.map((call) => call.name), ["overlayShow"]);
  pending.shift().reject(new Error("create modal webview: refused"));
  await turns();
  assert.equal(modalState()?.id, "dialog", "the refusal of the replaced modal closed the one on display");
  assert.deepEqual(refusals, []);
  while (pending.length) {
    pending.shift().resolve(rect);
    await turns();
  }
  overlay.hide();
  await turns();
  pending.shift().resolve();
  await orderedCallsAnswered();
});
