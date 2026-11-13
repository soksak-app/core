// The events and trace events that a plugin writes through its runtime reach the writers of the page (docs/spec/plugins.md#logging,
// docs/spec/plugins.md#tracing): the correlation identifiers travel with the event, the level gate is the one of the page writer, and a trace that is off builds nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPluginRuntime } from "@soksak/plugin-api";
import { selectPageWire } from "@soksak/runtime";
import { withoutClock } from "./support/records.mjs";

// The batches that the page sent to the host, without the clock statement that leads the first batch of the page.
const batchesOf = (wire) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload.action === "batch")
  .map(({ payload }) => withoutClock(payload))
  .flatMap(({ events }) => events);

test("an event of a plugin leaves with its cids and its builder runs while the level is stored", async () => {
  // The case selects the host of the page before the modules that read it are imported, because the page reads the host when it is imported.
  const wire = selectPageWire("plugin-records-event");
  const { pluginRecords } = await import("../plugin-records.js");
  const { flushEvents } = await import("../page-log.js");
  const { log } = createPluginRuntime({ pluginId: "probe", surfaceId: "tab-1", hooks: pluginRecords });
  log.info("started", { project: "p1" }, { cids: ["p1.1"] });
  log.debug("built", () => ({ rows: 2 }));
  await flushEvents();
  assert.deepEqual(batchesOf(wire).map(({ level, event, fields, cids }) => ({ level, event, fields, cids })), [
    { level: "info", event: "plugin.probe.started", fields: { project: "p1", surface: "tab-1" }, cids: ["p1.1"] },
    { level: "debug", event: "plugin.probe.built", fields: { rows: 2, surface: "tab-1" }, cids: undefined },
  ]);
  wire.finish();
});

test("the trace of a plugin builds no object while the trace is off", async () => {
  const wire = selectPageWire("plugin-records-trace-off");
  const { pluginRecords } = await import("../plugin-records.js");
  const { flushEvents } = await import("../page-log.js");
  const { trace } = createPluginRuntime({ pluginId: "probe", surfaceId: "tab-1", hooks: pluginRecords });
  let built = 0;
  assert.equal(trace.enabled(), false);
  trace("probe.step", () => { built += 1; return {}; });
  await flushEvents();
  assert.equal(built, 0);
  assert.deepEqual(batchesOf(wire), []);
  wire.finish();
});

test("an event of a state module has the plugin in its name and no surface in its fields", async () => {
  const wire = selectPageWire("plugin-records-state");
  const { pluginRecords } = await import("../plugin-records.js");
  const { flushEvents } = await import("../page-log.js");
  const { log, trace } = createPluginRuntime({ pluginId: "probe", hooks: pluginRecords });
  log.info("started", { project: "p1" });
  assert.equal(trace.enabled(), false);
  await flushEvents();
  assert.deepEqual(batchesOf(wire).map(({ event, fields }) => ({ event, fields })), [{ event: "plugin.probe.started", fields: { project: "p1" } }]);
  wire.finish();
});
