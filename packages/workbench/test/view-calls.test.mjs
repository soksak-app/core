// Checks the answers of the workbench to the call requests of a view (docs/spec/native-surfaces.md#view-surfaces). The tab state and
// the command runners are fakes, so the test runs without a host.
import assert from "node:assert/strict";
import test from "node:test";
import { answerViewCall } from "../view-calls.js";

function fakes() {
  const ran = { core: [], owned: [] };
  return {
    ran,
    options: {
      plugin: "probe",
      tab: { read: () => ({ count: 2 }) },
      runCore: async (name, params) => { ran.core.push({ name, params }); return { core: true }; },
      runOwned: async (name, params, owner) => { ran.owned.push({ name, params, owner }); return { owned: true }; },
    },
  };
}

test("a forwarded tab.state.read returns the tab state of its surface", async () => {
  const { options } = fakes();
  assert.deepEqual(await answerViewCall({ command: "tab.state.read", params: null }, options), { count: 2 });
});

test("tab.state.read is refused when the surface declares no tab state", async () => {
  const { options } = fakes();
  await assert.rejects(answerViewCall({ command: "tab.state.read", params: null }, { ...options, tab: null }), /tab state is not declared/);
});

test("a command of another plugin is refused and runs nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ command: "other.run", params: {} }, options), /belongs to other, not probe/);
  assert.deepEqual(ran.owned, []);
  assert.deepEqual(ran.core, []);
});

test("a core command runs through runCore and a command of the plugin through runOwned", async () => {
  const { ran, options } = fakes();
  assert.deepEqual(await answerViewCall({ command: "core.surface.open", params: { a: 1 } }, options), { core: true });
  assert.deepEqual(await answerViewCall({ command: "probe.run", params: { b: 2 } }, options), { owned: true });
  assert.deepEqual(ran.core, [{ name: "core.surface.open", params: { a: 1 } }]);
  assert.deepEqual(ran.owned, [{ name: "probe.run", params: { b: 2 }, owner: "probe" }]);
});
