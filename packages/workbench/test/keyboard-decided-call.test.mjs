// The decided call surfaceFocus {surface, decided: true} goes to the host in the turn that asks for it, also while an earlier
// ordered call has no answer, and the ordered calls after it follow its answer (docs/spec/native-surfaces.md#keyboard-of-a-surface).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<body><div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

// The host answers each call when the test lets it, and answers the application log at once.
const pending = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => Promise.resolve(() => {}),
  page: (path) => path,
  call: (name, request) => {
    if (name === "log") return request?.action === "clock" ? Promise.resolve({ ts_us: 1, mono_ns: 1 }) : Promise.resolve();
    return new Promise((resolve, reject) => pending.push({ name, request, resolve, reject }));
  },
  reload: () => {},
} } });
const { overlay, surfaces } = await import("../host.js");

// Lets the ordered calls that wait be sent.
const turns = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a decided call goes out while an earlier ordered call has no answer, and a later ordered call follows its answer", async () => {
  overlay.show(document.getElementById("menu"), { x: 0, y: 0, w: 10, h: 10 }, () => {});
  await turns();
  assert.deepEqual(pending.map((call) => call.name), ["overlayShow"]);
  surfaces.focus("tab-a", true);
  assert.deepEqual(pending.map((call) => call.name), ["overlayShow", "surfaceFocus"], "the decided call waited for the earlier ordered call");
  assert.deepEqual(pending[1].request, { surface: "tab-a", decided: true });
  surfaces.focus("tab-b");
  pending.shift().resolve({ x: 0, y: 0, w: 10, h: 10 });
  await turns();
  assert.deepEqual(pending.map((call) => call.name), ["surfaceFocus"], "an ordered call went out before the host answered the decided call");
  pending.shift().resolve();
  await turns();
  assert.deepEqual(pending.map((call) => [call.name, call.request]), [["surfaceFocus", { surface: "tab-b" }]]);
  pending.shift().resolve();
});
