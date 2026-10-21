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

test("the plugin-facing native handle subscribes only to the region events", { timeout: 5000 }, async () => {
  assert.equal(typeof viewCalls.pluginNativeGate, "function", "view-calls.js exports pluginNativeGate");
  const subscribed = [];
  const gate = viewCalls.pluginNativeGate({ call: async () => null, on: (name) => { subscribed.push(name); return () => {}; } });
  for (const name of REGION_EVENTS) gate.on(name, () => {});
  assert.deepEqual(subscribed, REGION_EVENTS);
  for (const name of VIEW_INTERNAL_EVENTS) await assert.rejects(gate.on(name, () => {}), /not served/, `${name} is refused`);
});
