// The operations of the page that change the application (docs/spec/logging.md#operation-chains): the page assigns a correlation
// identifier when an operation starts, stores the first event of its chain with it, and passes it with the host calls that carry
// the operation out, so the call (`page.call`) and the host (`host.binding.call`) are joined to the operation by it.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { clockAnswer, settled, withoutClock } from "./support/records.mjs";

const calls = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => { calls.push([name, withoutClock(payload)]); return clockAnswer(name, payload); },
} } });
const { beginOperation } = await import("../operations.js");
await import("../page-log.js");
const { createPluginOperations } = await import("../plugin-operations.js");
const { createAppUpdate } = await import("../app-update.js");
const { hostWindows } = await import("../host-windows.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { settlingCalls, observeHostCalls, callEvent } = await import("../host-calls.js");
const { logGate } = await import("../log-gate.js");
// The events below the level error are stored only in the debug state (docs/spec/settings.md, the section of core.settings.debug), which these tests
// examine, so the state of every class at trace is set here.
logGate.set({ lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" });

/** The events of the batches that the page relayed to the host. */
const events = () => calls.filter(([name]) => name === "log").flatMap(([, payload]) => payload.events ?? []);

test("an operation starts with an identifier of the page and the first event of its chain carries it", async () => {
  calls.length = 0;
  const first = beginOperation("page.plugin.operation", { action: "install", plugin: "term" });
  const second = beginOperation("page.plugin.operation", { action: "remove", plugin: "term" });
  await settled();
  assert.match(first[0], /^p\d+\.\d+$/);
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(events().map(({ level, event, fields, cids }) => [level, event, fields, cids]), [
    ["info", "page.plugin.operation", { action: "install", plugin: "term" }, first],
    ["info", "page.plugin.operation", { action: "remove", plugin: "term" }, second],
  ]);
});

test("a call that continues an operation passes its identifiers to the transport and states them in page.call", async () => {
  calls.length = 0;
  const sent = [];
  const wrapped = settlingCalls(async (name, arg, options) => { sent.push([name, arg, options]); if (name === "bad") throw new Error("refused"); });
  const seen = [];
  observeHostCalls((call) => seen.push(call));
  await wrapped.callContinuing(["p1.1"], "pluginsRun", { action: "install", plugin: "term" });
  await assert.rejects(wrapped.callContinuing(["p1.2"], "bad"), /refused/);
  await wrapped.call("plain", 1);
  observeHostCalls(null);
  assert.deepEqual(sent, [
    ["pluginsRun", { action: "install", plugin: "term" }, { cids: ["p1.1"] }],
    ["bad", undefined, { cids: ["p1.2"] }],
    ["plain", 1, { cids: undefined }],
  ]);
  assert.deepEqual(seen.map(({ name, cids }) => [name, cids]), [["pluginsRun", ["p1.1"]], ["bad", ["p1.2"]], ["plain", undefined]]);
  assert.deepEqual(callEvent({ name: "pluginsRun", args: [], micros: 1, ok: true, cids: ["p1.1"] }).cids, ["p1.1"]);
});

test("a plugin operation is stored first and carried out with the same identifiers", async () => {
  calls.length = 0;
  const host = { calls: [], async call(name, arg, options) { host.calls.push([name, arg, options]); return name === "pluginsState" ? { installed: { plugins: {}, sidecars: {} }, index: null, registry: null } : undefined; } };
  const operations = createPluginOperations({ host, loaded: () => [], changed: () => {} });
  await operations.run("install", "term");
  await settled();
  const [operation] = events().filter(({ event }) => event === "page.plugin.operation");
  assert.deepEqual(operation.fields, { action: "install", plugin: "term" });
  const run = host.calls.find(([name]) => name === "pluginsRun");
  assert.deepEqual(run, ["pluginsRun", { action: "install", plugin: "term" }, { cids: operation.cids }]);
});

test("the application update passes one identifier to its stage and its apply", async () => {
  calls.length = 0;
  const available = { version: "0.0.9", release: { url: "https://github.com/soksak-app/core/releases/download/v0.0.9/soksak-0.0.9-darwin-arm64-wailsv3.zip", sha256: "0".repeat(64) } };
  const host = { calls: [], async call(name, arg, options) {
    host.calls.push([name, arg, options]);
    if (name === "appUpdateState") return { version: "0.0.8", available };
    if (name === "appUpdateStage") return { bundle: "/stage/soksak.app" };
    return undefined;
  } };
  const update = createAppUpdate({ host, changed: () => {} });
  await update.refresh();
  await update.update();
  await settled();
  const [operation] = events().filter(({ event }) => event === "page.update.operation");
  assert.deepEqual(operation.fields, { action: "update", version: "0.0.9" });
  assert.deepEqual(host.calls.filter(([name]) => name === "appUpdateStage" || name === "appUpdateApply"), [
    ["appUpdateStage", { version: "0.0.9" }, { cids: operation.cids }],
    ["appUpdateApply", { bundle: "/stage/soksak.app" }, { cids: operation.cids }],
  ]);
});

test("the window and project calls of the host take the identifiers of their operation", async () => {
  const sent = [];
  const windows = hostWindows({ call: async (name, arg, options) => { sent.push([name, arg, options]); return { local: true }; }, on: () => {} });
  const cids = ["p1.7"];
  await windows.newWindow(cids);
  await windows.close(cids);
  await windows.closeKept(cids);
  await windows.openProject({ id: "prj", root: "/r", separate: false, geometry: null }, cids);
  await windows.projectShown({ id: "prj", root: "/r", title: "t" });
  await windows.projectShown(null);
  await windows.releaseProject("prj", cids);
  await windows.askRemoveProject("prj", cids);
  assert.deepEqual(sent, [
    ["windowNew", undefined, { cids }],
    ["windowClose", undefined, { cids }],
    ["windowCloseKept", undefined, { cids }],
    ["projectOpen", { id: "prj", root: "/r", separate: false, geometry: null }, { cids }],
    ["projectShown", { project: { id: "prj", root: "/r", title: "t" } }, undefined],
    ["projectShown", { project: null }, undefined],
    ["projectRelease", "prj", { cids }],
    ["projectRemoveAsk", "prj", { cids }],
  ]);
});

test("a change of the settings file passes the identifiers of its change to the host", async () => {
  const sent = [];
  const store = new HostWorkspaceStore({ call: async (name, arg, options) => { sent.push([name, arg, options]); }, on: () => {} });
  await store.settings("prj", { gap: 8, radius: undefined }, ["p1.9"]);
  assert.deepEqual(sent, [["workspace", { kind: "settings", id: "prj", patch: { gap: 8 }, remove: ["radius"] }, { cids: ["p1.9"] }]]);
});
