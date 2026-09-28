import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleListener } from "../runtime/listener-lifecycle.js";

test("Wails runtime removes native event listeners when the page is unloaded", async () => {
  let pagehide;
  let removed = 0;
  const listen = createLifecycleListener(async () => () => { removed++; }, {
    addEventListener(name, listener) { if (name === "pagehide") pagehide = listener; },
  });
  await listen("workspace-changed", () => {});
  assert.equal(removed, 0);
  pagehide();
  assert.equal(removed, 1);
});

test("Wails runtime removes a listener that resolves after unload", async () => {
  let pagehide;
  let resolveRegistration;
  let removed = 0;
  const listen = createLifecycleListener(() => new Promise((resolve) => { resolveRegistration = resolve; }), {
    addEventListener(name, listener) { if (name === "pagehide") pagehide = listener; },
  });
  const registration = listen("workspace-changed", () => {});
  pagehide();
  resolveRegistration(() => { removed++; });
  await registration;
  assert.equal(removed, 1);
});
