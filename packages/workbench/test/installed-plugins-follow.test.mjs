// A window subscribes to plugins-changed and then reads the plugin state once, so a change that the host made before the
// subscription is applied as well (docs/spec/installation.md#applying-a-change, F199.4).
import assert from "node:assert/strict";
import { test } from "node:test";

test("a plugin change made before the window follows plugin changes is applied once by the read after the subscription", async (t) => {
  const handlers = new Map();
  // The host installed the plugin `a` after the early read of the page and before it followed plugin changes.
  const installed = { plugins: { a: { version: "0.0.1", enabled: true, sidecars: {} } }, sidecars: {} };
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    call: async (name) => (name === "pluginsState" ? { registry: null, index: null, installed } : []),
    on: (event, fn) => { handlers.set(event, fn); },
  } } });
  t.mock.module("../environment.js", { namedExports: { pluginUnits: () => [] } });
  const { followPluginChanges } = await import("../installed-plugins.js");
  let applied = 0;
  let finish;
  const following = followPluginChanges(() => { applied += 1; return new Promise((resolve) => { finish = resolve; }); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(handlers.has("plugins-changed"), "the window did not subscribe to plugins-changed");
  assert.equal(applied, 1, "the change made before the subscription was not applied");
  // The same change seen again through the event while the apply runs starts no second apply.
  const event = handlers.get("plugins-changed")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied, 1, "the change seen twice was applied twice");
  finish({ reloaded: false });
  await Promise.all([following, event]);
});
