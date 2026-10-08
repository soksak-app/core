// The registry sends no change event, so the window reads the plugin state again when the host reports that the
// window became active (docs/spec/installation.md, Plugin screen).
import assert from "node:assert/strict";
import { test } from "node:test";

test("the plugin state is read again each time the host reports the window active", async (t) => {
  const calls = [];
  const handlers = new Map();
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    call: async (name) => { calls.push(name); return name === "pluginsState" ? { registry: null, index: null, installed: { plugins: {}, sidecars: {} } } : []; },
    on: (event, fn) => { handlers.set(event, fn); },
  } } });
  t.mock.module("../environment.js", { namedExports: { pluginUnits: () => [] } });
  const { followActivation } = await import("../installed-plugins.js");
  followActivation();
  assert.deepEqual(calls, [], "the state was read before the window became active");
  await handlers.get("window-active")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["pluginsState"]);
  await handlers.get("window-active")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["pluginsState", "pluginsState"]);
});
