import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// The open notice center is a window overlay as the error toasts are: its panel is cut out of the container of the surface hosts, so
// a native surface does not cover it (docs/spec/native-modals.md#toast-overlay).
test("an open notice center panel is cut out of the surface hosts with its toasts", async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="toasts"><div class="toast"></div></div><section class="notice-center"></section></body>');
  const { window } = dom;
  const { document } = window;
  t.after(() => window.close());
  Object.assign(globalThis, { window, document });
  const rect = (left, top, width, height) => () => ({ left, top, width, height });
  document.querySelector(".toast").getBoundingClientRect = rect(10, 20, 30, 40);
  document.querySelector(".notice-center").getBoundingClientRect = rect(500, 60, 280, 300);
  const { toastCuts } = await import("../host.js");
  assert.deepEqual(toastCuts(), [
    { x: 10, y: 20, w: 30, h: 40, cut: true },
    { x: 500, y: 60, w: 280, h: 300, cut: true },
  ]);
});
