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

test("the reports of snapshot channels count the skipped and stalled values of a plugin", async () => {
  const { createSnapshotSender } = await import("@soksak/plugin-api");
  const { losses, snapshotReporter } = await import("../plugin-processes.js");
  const sent = [];
  const sender = createSnapshotSender({
    plugin: "tree-probe",
    send: (message) => sent.push(message),
    onMessage: () => () => {},
    report: snapshotReporter("tree-probe"),
  });
  sender.push("tree-probe.tree", "v1");
  sender.push("tree-probe.tree", "v2");
  sender.push("tree-probe.tree", "v3");
  assert.deepEqual(losses().find((entry) => entry.plugin === "tree-probe"), { plugin: "tree-probe", skipped: 1, stalled: 0, abandoned: 0, lateReplies: 0, timeouts: 0, peerLost: 0 }, "the overwritten value counts one skip");
  sender.peerLost("surface-closed");
  assert.deepEqual(losses().find((entry) => entry.plugin === "tree-probe"), { plugin: "tree-probe", skipped: 1, stalled: 2, abandoned: 0, lateReplies: 0, timeouts: 0, peerLost: 0 });
  assert.equal(sent.length, 1);
});

// contract: view.responsiveness.relay
test("a view whose presentation wait ends without presentation counts losses.abandoned of its plugin", async () => {
  const { losses, presentationAbandoned } = await import("../plugin-processes.js");
  presentationAbandoned("abandon-probe");
  presentationAbandoned("abandon-probe");
  assert.deepEqual(losses().find((entry) => entry.plugin === "abandon-probe"), { plugin: "abandon-probe", skipped: 0, stalled: 0, abandoned: 2, lateReplies: 0, timeouts: 0, peerLost: 0 }, "each notice counts one abandoned presentation of the plugin");
});

test("a view responsiveness notice is the state of its surface until the surface is disposed", async () => {
  const { forgetView, views, viewResponsiveness } = await import("../plugin-processes.js");
  viewResponsiveness("probe", "responsive-probe-surface", false);
  assert.deepEqual(views(), [{ plugin: "probe", surface: "responsive-probe-surface", responsive: false }]);
  viewResponsiveness("probe", "responsive-probe-surface", true);
  assert.deepEqual(views(), [{ plugin: "probe", surface: "responsive-probe-surface", responsive: true }], "the state follows the last notice");
  forgetView("responsive-probe-surface");
  assert.deepEqual(views().filter((entry) => entry.surface === "responsive-probe-surface"), [], "a disposed surface keeps no state");
});

// contract: view.responsiveness.relay
test("a view responsiveness notice that is not a boolean is refused and changes no state", async () => {
  const { views, viewResponsiveness } = await import("../plugin-processes.js");
  assert.throws(() => viewResponsiveness("probe", "refused-probe-surface", "no"), /responsive is not a boolean/);
  assert.deepEqual(views().filter((entry) => entry.surface === "refused-probe-surface"), []);
});

// contract: view.snapshot.skipped-count
// The reports of a snapshot channel write the page trace event of each skipped value. A stalled value is counted and writes no event,
// because no live observer waits for its acknowledgement (docs/spec/plugin-processes.md, rule 2).
test("the reports of a snapshot channel write the page trace event of skipped values and count stalled values without an event", async (t) => {
  const traced = [];
  t.mock.module("../performance.js", { exports: { trace: (event, fields) => { traced.push({ event, fields }); } } });
  const { snapshotReporter } = await import("../plugin-processes.js?page-trace");
  const report = snapshotReporter("trace-probe");
  report({ kind: "skipped", plugin: "trace-probe", status: "trace-probe.tree", count: 1 });
  report({ kind: "stalled", plugin: "trace-probe", status: "trace-probe.tree", reason: "surface-closed", count: 1 });
  assert.deepEqual(traced, [
    { event: "declared-ui.snapshot.skipped", fields: { plugin: "trace-probe", status: "trace-probe.tree", count: 1 } },
  ]);
  const { losses } = await import("../plugin-processes.js?page-trace");
  assert.equal(losses().find((entry) => entry.plugin === "trace-probe").stalled, 1, "the stalled value is counted");
});
