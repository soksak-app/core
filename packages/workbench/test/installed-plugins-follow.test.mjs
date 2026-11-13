// A window subscribes to plugins-changed and then reads the plugin state once, so a change that the host made before the
// subscription is applied as well; an event during a running apply runs one more apply after it, which reads the
// state again (docs/spec/installation.md#applying-a-change, F199.4).
import assert from "node:assert/strict";
import { test } from "node:test";

test("a change before the subscription is applied, and a newer change during the apply runs one more apply", async (t) => {
  const handlers = new Map();
  // The host installed the plugin `a` after the early read of the page and before it followed plugin changes.
  const installed = { plugins: { a: { version: "0.0.1", enabled: true, sidecars: {} } }, sidecars: {} };
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    call: async (name) => (name === "pluginsState" ? { registry: null, index: null, installed: structuredClone(installed) } : []),
    on: (event, fn) => { handlers.set(event, fn); },
  } } });
  t.mock.module("../environment.js", { namedExports: { pluginUnits: () => [], refusedPlugins: () => new Set() } });
  const { followPluginChanges, pluginOperations } = await import("../installed-plugins.js");
  const seen = [];
  const finishes = [];
  // The starts of the applies and the end of the first, in their order.
  const order = [];
  // arrival() gives a promise that resolves when the next apply starts.
  let applied = () => {};
  const arrival = () => new Promise((resolve) => { applied = resolve; });
  const firstApply = arrival();
  const following = followPluginChanges(() => {
    seen.push(pluginOperations.status().plugins.map((row) => row.id));
    order.push("start");
    applied();
    return new Promise((resolve) => { finishes.push(resolve); });
  });
  await firstApply;
  assert.ok(handlers.has("plugins-changed"), "the window did not subscribe to plugins-changed");
  assert.deepEqual(seen, [["a"]], "the change made before the subscription was not applied");
  // The host installs `b` while the first apply runs; the event starts no second apply at the same time.
  installed.plugins.b = { version: "0.0.1", enabled: true, sidecars: {} };
  const event = handlers.get("plugins-changed")();
  const secondApply = arrival();
  order.push("first ended");
  finishes[0]({ reloaded: false });
  await secondApply;
  assert.deepEqual(order, ["start", "first ended", "start"], "a second apply ran while the first one ran");
  assert.deepEqual(seen, [["a"], ["a", "b"]], "the change made during the apply was not applied");
  finishes[1]({ reloaded: false });
  await Promise.all([following, event]);
});
