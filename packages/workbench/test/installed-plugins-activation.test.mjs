// The registry sends no change event, so the window reads the plugin state and the application update again when the
// host reports that the window became active (docs/spec/installation.md, Plugin screen).
import assert from "node:assert/strict";
import { test } from "node:test";

test("the plugin state and the application update are read again each time the host reports the window active", async (t) => {
  const calls = [];
  const handlers = new Map();
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    call: async (name) => { calls.push(name); return name === "appUpdateState" ? { version: "0.0.8", available: null } : name === "pluginsState" ? { registry: null, index: null, installed: { plugins: {}, sidecars: {} } } : []; },
    on: (event, fn) => { handlers.set(event, fn); },
  } } });
  t.mock.module("../environment.js", { namedExports: { pluginUnits: () => [] } });
  const emitted = [];
  t.mock.module("../page-log.js", { namedExports: { emitEvent: (level, event, fields) => { emitted.push([level, event, fields]); } } });
  const { followActivation } = await import("../installed-plugins.js");
  followActivation();
  assert.deepEqual(calls, [], "the state was read before the window became active");
  await handlers.get("window-active")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.toSorted(), ["appUpdateState", "pluginsState"]);
  await handlers.get("window-active")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.toSorted(), ["appUpdateState", "appUpdateState", "pluginsState", "pluginsState"]);
  // Each host event is recorded when the page receives it, and the registry reread is recorded after the state is read.
  assert.deepEqual(emitted, [
    ["info", "page.window.active", {}],
    ["info", "page.plugins.reread", { updates: 0 }],
    ["info", "page.window.active", {}],
    ["info", "page.plugins.reread", { updates: 0 }],
  ]);
});
