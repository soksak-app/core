// The events and trace events that a plugin writes through its runtime reach the writers of the page (docs/spec/plugins.md#logging,
// docs/spec/plugins.md#tracing): the correlation identifiers travel with the event, the level gate is the one of the page writer, and a trace that is off builds nothing.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createPluginRuntime } from "@soksak/plugin-api";
import { clockAnswer, settled, withoutClock } from "./support/records.mjs";

const calls = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => {
    const clock = clockAnswer(name, payload);
    if (clock) return clock;
    calls.push({ name, payload: withoutClock(payload) });
  },
} } });
const { pluginRecords } = await import("../plugin-records.js");

const batches = () => calls.filter(({ name }) => name === "log").flatMap(({ payload }) => payload.events);

test("an event of a plugin leaves with its cids and its builder runs while the level is stored", async () => {
  calls.length = 0;
  const { log } = createPluginRuntime({ pluginId: "probe", surfaceId: "tab-1", hooks: pluginRecords });
  assert.equal(log.enabled("trace"), true);
  log.info("started", { project: "p1" }, { cids: ["p1.1"] });
  log.debug("built", () => ({ rows: 2 }));
  await settled();
  assert.deepEqual(batches().map(({ level, event, fields, cids }) => ({ level, event, fields, cids })), [
    { level: "info", event: "plugin.probe.started", fields: { project: "p1", surface: "tab-1" }, cids: ["p1.1"] },
    { level: "debug", event: "plugin.probe.built", fields: { rows: 2, surface: "tab-1" }, cids: undefined },
  ]);
});

test("the trace of a plugin builds no object while the trace is off", async () => {
  calls.length = 0;
  const { trace } = createPluginRuntime({ pluginId: "probe", surfaceId: "tab-1", hooks: pluginRecords });
  let built = 0;
  assert.equal(trace.enabled(), false);
  trace("probe.step", () => { built += 1; return {}; });
  await settled();
  assert.equal(built, 0);
  assert.deepEqual(batches(), []);
});

test("an event of a state module has the plugin in its name and no surface in its fields", async () => {
  calls.length = 0;
  const { log, trace } = createPluginRuntime({ pluginId: "probe", hooks: pluginRecords });
  log.info("started", { project: "p1" });
  assert.equal(trace.enabled(), false);
  await settled();
  assert.deepEqual(batches().map(({ event, fields }) => ({ event, fields })), [{ event: "plugin.probe.started", fields: { project: "p1" } }]);
});
