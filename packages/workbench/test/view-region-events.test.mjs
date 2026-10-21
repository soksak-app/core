// Checks the region events that the plugin-facing native handle subscribes to (docs/spec/native-surfaces.md#view-surfaces, regions).
import assert from "node:assert/strict";
import test from "node:test";
import * as viewCalls from "../view-calls.js";

const REGION_EVENTS = ["document-stream", "document-state", "document-message", "image-event"];
const VIEW_INTERNAL_EVENTS = ["view-call", "view-reply", "view-stopped", "view-responsiveness", "view-presentation-abandoned"];

test("the region events are exactly the four region events of the workbench", { timeout: 5000 }, () => {
  assert.ok(viewCalls.REGION_EVENTS instanceof Set, "view-calls.js exports REGION_EVENTS as a Set");
  assert.deepEqual([...viewCalls.REGION_EVENTS].sort(), [...REGION_EVENTS].sort());
});

test("a view subscribes to exposure-request and is answered through the gate", { timeout: 5000 }, async () => {
  // docs/spec/native-surfaces.md#view-surfaces, view exposure: the forwarded exposure request reaches the view through this subscription.
  let deliver = null;
  const gate = viewCalls.pluginNativeGate({ call: async () => null, on: (name, listener) => { deliver = { name, listener }; return () => {}; } });
  const received = [];
  await gate.on("exposure-request", (request) => received.push(request));
  assert.equal(deliver.name, "exposure-request", "the gate forwards the subscription to the native handle");
  const request = { id: 7, surface: "s1", method: "status.get", params: {} };
  deliver.listener(request);
  assert.deepEqual(received, [request], "the view receives the exposure request");
});

test("the plugin-facing native handle subscribes only to the region events and exposure-request", { timeout: 5000 }, async () => {
  assert.equal(typeof viewCalls.pluginNativeGate, "function", "view-calls.js exports pluginNativeGate");
  assert.deepEqual([...viewCalls.PLUGIN_NATIVE_EVENTS].sort(), [...REGION_EVENTS, "exposure-request"].sort());
  const subscribed = [];
  const gate = viewCalls.pluginNativeGate({ call: async () => null, on: (name) => { subscribed.push(name); return () => {}; } });
  for (const name of REGION_EVENTS) gate.on(name, () => {});
  assert.deepEqual(subscribed, [...REGION_EVENTS]);
  for (const name of VIEW_INTERNAL_EVENTS) await assert.rejects(gate.on(name, () => {}), /not served/, `${name} is refused`);
  await assert.rejects(gate.on("exposure-registered", () => {}), /not served/, "an unlisted event is refused");
});
