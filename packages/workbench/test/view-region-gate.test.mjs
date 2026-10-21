// Checks the gate of the region calls of the plugin-facing native handle (docs/spec/native-surfaces.md#view-surfaces, regions). The
// host is a fake that records each call it receives, so a refused name is shown by the absence of its record.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { answerViewCall } from "../view-calls.js";
import * as viewCalls from "../view-calls.js";

function fakeNative() {
  const sent = [];
  return {
    sent,
    native: {
      call: async (name, payload) => { sent.push({ name, payload }); return null; },
      on: () => () => {},
    },
  };
}

// The literal region names that the workbench passes to a host call. A name missing from the region allowlist is a region call
// that the view could reach through its native handle.
test("the region calls of the workbench host routes are the names of the region allowlist", { timeout: 5000 }, () => {
  const source = readFileSync(new URL("../surface-modules.js", import.meta.url), "utf8")
    + readFileSync(new URL("../host.js", import.meta.url), "utf8");
  assert.ok(viewCalls.REGION_HOST_CALLS instanceof Set, "view-calls.js exports REGION_HOST_CALLS as a Set");
  const literals = new Set();
  for (const match of source.matchAll(/\b(?:invoke|composed|hostClose|bridge\.call|scoped\.native\.call)\(\s*"((?:document|image|composition)[A-Za-z]*)"/g)) {
    literals.add(match[1]);
  }
  for (const name of literals) assert.ok(viewCalls.REGION_HOST_CALLS.has(name), `${name} is in the region allowlist`);
  assert.ok(literals.has("documentQuery") && literals.has("documentInteractionState"), "the scan finds the two bridge region calls");
});

test("the plugin-facing native handle refuses every region call and view bridge call", { timeout: 5000 }, async () => {
  assert.equal(typeof viewCalls.pluginNativeGate, "function", "view-calls.js exports pluginNativeGate");
  assert.ok(viewCalls.VIEW_BRIDGE_CALLS instanceof Set, "view-calls.js exports VIEW_BRIDGE_CALLS as a Set");
  const fake = fakeNative();
  const gate = viewCalls.pluginNativeGate(fake.native);
  for (const name of [...viewCalls.REGION_HOST_CALLS, ...viewCalls.VIEW_BRIDGE_CALLS]) {
    await assert.rejects(gate.call(name, {}), /not served/, `${name} is refused`);
  }
  assert.deepEqual(fake.sent, [], "no refused name reaches the host");
});

test("a view run refuses each region name and each view bridge name through its native call", { timeout: 5000 }, async () => {
  assert.equal(typeof viewCalls.pluginNativeGate, "function", "view-calls.js exports pluginNativeGate");
  const fake = fakeNative();
  const options = {
    plugin: "probe",
    pending: new Map(),
    tab: {},
    runCore: async () => null,
    runOwned: async () => null,
    runtime: { native: viewCalls.pluginNativeGate(fake.native), subscribe: {}, log: {} },
    composition: {},
  };
  for (const name of [...viewCalls.REGION_HOST_CALLS, ...viewCalls.VIEW_BRIDGE_CALLS]) {
    await assert.rejects(answerViewCall({ id: 1, command: "runtime.native.call", params: { name, payload: {} } }, options), /not served/);
  }
  assert.deepEqual(fake.sent, []);
});
