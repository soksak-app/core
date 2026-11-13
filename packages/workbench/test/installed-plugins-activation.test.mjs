// The registry sends no change event, so the window reads the plugin state and the application update again when the
// host reports that the window became active (docs/spec/installation.md, Plugin screen).
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

// The host calls of the page are answered by the page-wire case of the test (docs/spec/cases/page-wire/README.md). The case is selected
// before the workbench modules are imported, because the page reads the host when it imports them.
const wire = selectPageWire("installed-plugins-activation-window-active");
const { followActivation } = await import("../installed-plugins.js");
const { flushEvents } = await import("../page-log.js");
const { logGate } = await import("../log-gate.js");
// The lifecycle events of the page are stored only at the level info, which the test examines, so the gate stores that class.
logGate.set({ lifecycle: "info", input: "error", call: "error", io: "error", frame: "error" });

// The calls of the page to the host, without the log calls that carry its records.
const hostCalls = () => wire.calls.filter(({ name }) => name !== "log").map(({ name }) => name);
// The events of the log batches of the page in the order they were relayed, without the clock record of the first batch.
const stored = () => wire.calls
  .filter(({ name }) => name === "log")
  .flatMap(({ payload }) => payload.events ?? [])
  .filter(({ event }) => event !== "workbench.log.clock")
  .map(({ level, event, fields }) => [level, event, fields]);

test("the plugin state and the application update are read again each time the host reports the window active", async () => {
  followActivation();
  assert.deepEqual(wire.calls, [], "the state was read before the window became active");
  // The first window-active notice: the state and the update are read, then the batch of the window event and the reread record follow.
  wire.deliverNotice();
  await flushEvents();
  assert.deepEqual(hostCalls().toSorted(), ["appUpdateState", "pluginsState"]);
  wire.deliverNotice();
  await flushEvents();
  assert.deepEqual(hostCalls().toSorted(), ["appUpdateState", "appUpdateState", "pluginsState", "pluginsState"]);
  // Each host event is recorded when the page receives it, and the registry reread is recorded after the state is read.
  assert.deepEqual(stored(), [
    ["info", "workbench.window.active", {}],
    ["info", "workbench.plugins.reread", { updates: 0 }],
    ["info", "workbench.window.active", {}],
    ["info", "workbench.plugins.reread", { updates: 0 }],
  ]);
  wire.finish();
});
