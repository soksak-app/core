import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateExposureFile } from "@soksak/plugin-api";

const PLUGIN_STATUSES = ["core.plugin.open-calls", "core.plugin.losses", "core.plugin.views"];

const declaredExposure = () => validateExposureFile(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

test("the plugin process statuses are declared by the core exposure file", () => {
  const { status } = declaredExposure().exposes;
  const names = status.map((entry) => entry.name);
  for (const name of PLUGIN_STATUSES) assert.ok(names.includes(name), `${name} is not declared in exposure.json`);
});

test("each plugin process status is registered and publishes its empty initial value", async () => {
  const { createRegistry } = await import("../exposure.js");
  const { losses, openCalls, views } = await import("../plugin-processes.js");
  const readers = { "core.plugin.open-calls": openCalls, "core.plugin.losses": losses, "core.plugin.views": views };
  const made = createRegistry();
  made.declare("core", declaredExposure().exposes);
  for (const name of PLUGIN_STATUSES) made.status(name, readers[name], () => () => {});
  for (const name of PLUGIN_STATUSES) {
    const empty = await made.handle({ method: "status.get", params: { name } });
    assert.deepEqual(empty, { result: [] }, `${name} initial value`);
  }
});

test("the reports of call layers fill the open-call and loss statuses, and each change is announced", async (t) => {
  const { createCalls } = await import("@soksak/plugin-api");
  const { callReporter, losses, openCalls, onPluginProcessChange } = await import("../plugin-processes.js");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let announced = 0;
  const stop = onPluginProcessChange(() => { announced += 1; });
  const layer = () => createCalls({
    plugin: "probe",
    send: () => {},
    onMessage: () => () => {},
    report: callReporter("probe"),
  });
  const started = Date.now();
  const first = layer();
  const timedOut = first.request("probe.run", {}, { timeout: 1000 });
  const rejected = assert.rejects(timedOut, { code: -32000 });
  const second = layer();
  const read = second.request("probe.read");
  const readRejected = assert.rejects(read, { reason: "process-ended" });
  assert.deepEqual(openCalls(), [{ plugin: "probe", count: 2, oldestStartedAt: started }]);
  t.mock.timers.tick(1000);
  await rejected;
  assert.deepEqual(losses(), [{ plugin: "probe", skipped: 0, stalled: 0, abandoned: 0, lateReplies: 0, timeouts: 1, peerLost: 0 }]);
  second.peerLost("process-ended");
  await readRejected;
  assert.deepEqual(openCalls(), []);
  assert.deepEqual(losses()[0], { plugin: "probe", skipped: 0, stalled: 0, abandoned: 0, lateReplies: 0, timeouts: 1, peerLost: 0 });
  const closed = layer();
  const surfaceClosed = closed.request("probe.run");
  const surfaceRejected = assert.rejects(surfaceClosed, { reason: "surface-closed" });
  closed.peerLost("surface-closed");
  await surfaceRejected;
  assert.equal(losses()[0].peerLost, 1);
  assert.ok(announced > 0);
  stop();
});
