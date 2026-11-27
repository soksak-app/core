import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// The host of the motion calls is passed to watchReduceMotion, so the test answers the calls of the host itself.
const listeners = new Map();
let motionAnswer = { reduce: null };
const motionHost = {
  call: async (name) => (name === "motion" ? motionAnswer : null),
  on: (name, fn) => listeners.set(name, fn),
};

// The reduced motion of the page is the override of the application when one is set, else the platform value, and the root element
// carries the effective value in data-reduce-motion (docs/spec/endpoint.md#diagnostic-builds).
test("the override wins over the platform value, and null reads the platform value", async () => {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window, document: window.document });
  const { reduceMotionValue, applyReduceMotion } = await import("../host.js");
  assert.equal(reduceMotionValue(null, true), true);
  assert.equal(reduceMotionValue(null, false), false);
  assert.equal(reduceMotionValue(false, true), false);
  assert.equal(reduceMotionValue(true, false), true);
  applyReduceMotion(window.document.documentElement, false, true);
  assert.equal(window.document.documentElement.dataset.reduceMotion, "false");
  applyReduceMotion(window.document.documentElement, null, true);
  assert.equal(window.document.documentElement.dataset.reduceMotion, "true");
  window.close();
});

// The page reads the override at start and follows the motion event; a null answer returns it to the platform value.
test("the page follows the motion call and the motion event of the host", async () => {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  let platformReduces = false;
  window.matchMedia = () => ({ get matches() { return platformReduces; }, addEventListener() {} });
  Object.assign(globalThis, { window, document: window.document });
  const { watchReduceMotion } = await import("../host.js");
  const root = window.document.documentElement;
  motionAnswer = { reduce: true };
  watchReduceMotion(root, motionHost);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(root.dataset.reduceMotion, "true");
  listeners.get("motion")({ reduce: false });
  assert.equal(root.dataset.reduceMotion, "false");
  platformReduces = true;
  listeners.get("motion")({ reduce: null });
  assert.equal(root.dataset.reduceMotion, "true", "null reads the platform value, which reduces motion");
  assert.throws(() => listeners.get("motion")({ reduce: "yes" }), /boolean or null/);
  window.close();
});
