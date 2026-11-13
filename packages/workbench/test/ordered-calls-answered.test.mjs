// A core command answers after the host answered the ordered calls that it sent, so a modal that the command opened holds the
// input of the window when the command answers (docs/spec/native-modals.md#keyboard).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu" style="border-top-color: rgb(7, 8, 9); background-color: rgb(255, 255, 255); border-top-left-radius: 4px"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

// The host calls of the page are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). The case of the
// first test is selected before the host module is imported, because the module reads the host when it is imported.
let wire = selectPageWire("ordered-calls-answered-show");
const { orderedCallsAnswered, overlay } = await import("../host.js");

// Lets the page send the calls that it queued in the current turn.
const settled = () => new Promise((resolve) => setImmediate(resolve));
// The names of the calls of the page in the order it sent them.
const names = () => wire.calls.map(({ name }) => name);

test("the wait of the ordered calls ends after the host answered the show of a modal", async () => {
  const el = document.getElementById("menu");
  overlay.show(el, { x: 0, y: 0, w: 10, h: 10 }, () => {});
  let answered = false;
  const waiting = orderedCallsAnswered().then(() => { answered = true; });
  await settled();
  assert.deepEqual(names(), ["overlayShow"]);
  assert.equal(answered, false, "the wait ended before the host answered the show of the modal");
  wire.release();
  await waiting;
  assert.equal(answered, true);
  wire.finish();
});

test("a show that failed ends the wait too, so the command still answers", async () => {
  wire = selectPageWire("ordered-calls-answered-refused");
  const el = document.getElementById("menu");
  overlay.show(el, { x: 0, y: 0, w: 10, h: 10 }, () => {});
  const wait = orderedCallsAnswered();
  await settled();
  // The show replaces the open modal, so its hide goes first.
  assert.deepEqual(names(), ["overlayHide"]);
  wire.release();
  await settled();
  assert.deepEqual(names(), ["overlayHide", "overlayShow"]);
  wire.release();
  await wait;
  // The failure of the show was written to the application log before the wait ended.
  const batches = wire.calls.filter(({ name }) => name === "log").map(({ payload }) => JSON.stringify(payload));
  assert.ok(batches.some((batch) => batch.includes('"where":"host overlayShow failed","text":"Error: create modal webview: refused"')),
    `the application log holds no failure of the show: ${batches.join("\n")}`);
  // The refused show hides the modal after its failure, and the ordered calls wait for that hide as well.
  await orderedCallsAnswered();
  assert.deepEqual(names().slice(-1), ["overlayHide"]);
  wire.finish();
});
