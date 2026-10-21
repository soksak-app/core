// Checks the deny-by-default allowlist of the plugin-facing native handle (docs/spec/native-surfaces.md#view-surfaces): a host command
// outside PLUGIN_HOST_CALLS is refused and never reaches the host.
import assert from "node:assert/strict";
import test from "node:test";
import * as viewCalls from "../view-calls.js";

test("the plugin-facing native handle refuses every host command outside its allowlist", { timeout: 5000 }, async () => {
  assert.equal(typeof viewCalls.pluginNativeGate, "function", "view-calls.js exports pluginNativeGate");
  assert.ok(viewCalls.PLUGIN_HOST_CALLS instanceof Set, "view-calls.js exports PLUGIN_HOST_CALLS as a Set");
  const sent = [];
  const gate = viewCalls.pluginNativeGate({ call: async (name) => { sent.push(name); return null; }, on: () => () => {} });
  await assert.rejects(gate.call("linkOpen", { url: "https://example.test" }), /not served/);
  await assert.rejects(gate.call("projectRemoveAnswer", { id: "a", allowed: true }), /not served/);
  assert.deepEqual(sent, []);
  for (const name of viewCalls.PLUGIN_HOST_CALLS) await gate.call(name, {});
  assert.deepEqual(sent, [...viewCalls.PLUGIN_HOST_CALLS]);
});
