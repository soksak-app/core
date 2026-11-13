// The operations of the page that change the application (docs/spec/logging.md#operation-chains): the page assigns a correlation
// identifier when an operation starts, stores the first event of its chain with it, and passes it with the host calls that carry
// the operation out, so the call (`workbench.call`) and the host (`host.binding.call`) are joined to the operation by it.
// The host calls are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). The first case is selected
// before the log module is imported, because the batcher of the page is created when that module reads the host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { host, selectPageWire } from "@soksak/runtime";
import { withoutClock } from "./support/records.mjs";

const startWire = selectPageWire("operations-start");
const { beginOperation } = await import("../operations.js");
const { flushEvents } = await import("../page-log.js");
const { createPluginOperations } = await import("../plugin-operations.js");
const { createAppUpdate } = await import("../app-update.js");
const { hostWindows } = await import("../host-windows.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { settlingCalls, observeHostCalls, callEvent } = await import("../host-calls.js");
const { logGate } = await import("../log-gate.js");
// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug), which these tests
// examine, so the state of every class at trace is set here.
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

/** The events of the batches that the page relayed to the host of the case. */
const events = (wire) => wire.calls.filter(({ name }) => name === "log").flatMap(({ payload }) => withoutClock(payload).events ?? []);

test("an operation starts with an identifier of the page and the first event of its chain carries it", async () => {
  const wire = startWire;
  const first = beginOperation("workbench.plugin.operation", { action: "install", plugin: "tty" });
  const second = beginOperation("workbench.plugin.operation", { action: "remove", plugin: "tty" });
  await flushEvents();
  assert.match(first[0], /^p[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+$/);
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(events(wire).map(({ level, event, fields, cids }) => [level, event, fields, cids]), [
    ["info", "workbench.plugin.operation", { action: "install", plugin: "tty" }, first],
    ["info", "workbench.plugin.operation", { action: "remove", plugin: "tty" }, second],
  ]);
  wire.finish();
});

test("a call that continues an operation passes its identifiers to the transport and states them in workbench.call", async () => {
  const wire = selectPageWire("operations-continue");
  const transport = settlingCalls(host.call);
  const seen = [];
  observeHostCalls((call) => seen.push(call));
  await transport.callContinuing(["p1.1"], "pluginsRun", { action: "install", plugin: "tty" });
  await assert.rejects(transport.callContinuing(["p1.2"], "bad"), /refused/);
  await transport.call("plain", 1);
  observeHostCalls(null);
  assert.deepEqual(wire.calls.map(({ name, payload, cids }) => [name, payload, { cids }]), [
    ["pluginsRun", { action: "install", plugin: "tty" }, { cids: ["p1.1"] }],
    ["bad", undefined, { cids: ["p1.2"] }],
    ["plain", 1, { cids: undefined }],
  ]);
  assert.deepEqual(seen.map(({ name, cids }) => [name, cids]), [["pluginsRun", ["p1.1"]], ["bad", ["p1.2"]], ["plain", undefined]]);
  assert.deepEqual(callEvent({ name: "pluginsRun", args: [], micros: 1, ok: true, cids: ["p1.1"] }).cids, ["p1.1"]);
  wire.finish();
});

test("a plugin operation is stored first and carried out with the same identifiers", async () => {
  const wire = selectPageWire("operations-plugin");
  const operations = createPluginOperations({ host, loaded: () => [], refused: () => new Set(), changed: () => {} });
  await operations.run("install", "tty");
  await flushEvents();
  const [operation] = events(wire).filter(({ event }) => event === "workbench.plugin.operation");
  assert.deepEqual(operation.fields, { action: "install", plugin: "tty" });
  const run = wire.calls.find(({ name }) => name === "pluginsRun");
  assert.deepEqual([run.name, run.payload, { cids: run.cids }], ["pluginsRun", { action: "install", plugin: "tty" }, { cids: operation.cids }]);
  wire.finish();
});

test("the application update passes one identifier to its stage and its apply", async () => {
  const wire = selectPageWire("operations-update");
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await update.update();
  await flushEvents();
  const [operation] = events(wire).filter(({ event }) => event === "workbench.update.operation");
  assert.deepEqual(operation.fields, { action: "update", version: "0.0.9" });
  assert.deepEqual(wire.calls.filter(({ name }) => name === "appUpdateStage" || name === "appUpdateApply").map(({ name, payload, cids }) => [name, payload, { cids }]), [
    ["appUpdateStage", { version: "0.0.9" }, { cids: operation.cids }],
    ["appUpdateApply", { bundle: "/stage/soksak.app" }, { cids: operation.cids }],
  ]);
  wire.finish();
});

test("the window and project calls of the host take the identifiers of their operation", async () => {
  const wire = selectPageWire("operations-window");
  const windows = hostWindows(host);
  const cids = ["p1.7"];
  await windows.newWindow(cids);
  await windows.close(cids);
  await windows.closeKept(cids);
  await windows.openProject({ id: "prj", root: "/r", separate: false, geometry: null }, cids);
  await windows.projectShown({ id: "prj", root: "/r", title: "t", activeSpaceId: "space-1", spaces: [] });
  await windows.projectShown(null);
  await windows.releaseProject("prj", cids);
  await windows.askRemoveProject("prj", cids);
  assert.deepEqual(wire.calls.map(({ name, payload, cids: sent }) => [name, payload, sent === undefined ? undefined : { cids: sent }]), [
    ["windowNew", undefined, { cids }],
    ["windowClose", undefined, { cids }],
    ["windowCloseKept", undefined, { cids }],
    ["projectOpen", { id: "prj", root: "/r", separate: false, geometry: null }, { cids }],
    ["projectShown", { project: { id: "prj", root: "/r", title: "t" } }, undefined],
    ["projectShown", { project: null }, undefined],
    ["projectRelease", "prj", { cids }],
    ["projectRemoveAsk", "prj", { cids }],
  ]);
  wire.finish();
});

test("a change of the settings file passes the identifiers of its change to the host", async () => {
  const wire = selectPageWire("operations-settings");
  const store = new HostWorkspaceStore(host);
  await store.settings("prj", { gap: 8, radius: undefined }, ["p1.9"]);
  assert.deepEqual(wire.calls.map(({ name, payload, cids }) => [name, payload, { cids }]),
    [["workspace", { kind: "settings", id: "prj", patch: { gap: 8 }, remove: ["radius"] }, { cids: ["p1.9"] }]]);
  wire.finish();
});
