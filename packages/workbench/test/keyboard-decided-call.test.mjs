// The decided call surfaceFocus {surface, decided: true} goes to the host in the turn that asks for it, also while an earlier
// ordered call has no answer, and the ordered calls after it follow its answer (docs/spec/native-surfaces.md#keyboard-of-a-surface).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The host calls of the page are answered by the case of this test; it is selected before host.js is imported, because the page reads the host when it is imported.
const wire = selectPageWire("keyboard-decided-call-order");
const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu" style="border-top-color: rgb(7, 8, 9); background-color: rgb(10, 11, 12); border-top-left-radius: 4px"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const { orderedCallsAnswered, overlay, surfaces } = await import("../host.js");

test("a decided call goes out while an earlier ordered call has no answer, and a later ordered call follows its answer", async () => {
  overlay.show(document.getElementById("menu"), { x: 0, y: 0, w: 10, h: 10 }, () => {});
  // The promise of the queue at this point ends when the show is answered, which is the last ordered call sent so far.
  const showAnswered = orderedCallsAnswered();
  // The show is sent after one turn of the page, so the test waits for that turn before it reads the calls.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(wire.calls.map((call) => call.name), ["overlayShow"]);
  surfaces.focus("tab-a", true);
  assert.deepEqual(wire.calls.map((call) => call.name), ["overlayShow", "surfaceFocus"], "the decided call waited for the earlier ordered call");
  assert.deepEqual(wire.calls[1].payload, { surface: "tab-a", decided: true });
  surfaces.focus("tab-b");
  wire.release();
  // The ordered call tab-b is queued behind the show and the decided call. showAnswered ends with the show, so the check runs
  // after the queue has sent every call that the show allows, and the decided call is still unanswered.
  await showAnswered;
  assert.deepEqual(wire.calls.map((call) => call.name), ["overlayShow", "surfaceFocus"], "an ordered call went out before the host answered the decided call");
  wire.release();
  await orderedCallsAnswered();
  assert.deepEqual(wire.calls.map((call) => call.name), ["overlayShow", "surfaceFocus", "surfaceFocus"]);
  assert.deepEqual(wire.calls[2].payload, { surface: "tab-b" }, "the ordered call names the tab-b surface");
  wire.finish();
});
