import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { memoryPlacement } from "../memory-placement.js";

const failure = new Error("tab-state startup fixture failed");
mock.module("@soksak/runtime", { namedExports: { windows: {
  onActivate: async () => {}, onCloseRequest: async () => {}, onRemoveProjectRequest: async () => {}, ready: async () => {},
} } });
mock.module("../page-log.js", { namedExports: { flushEvents: async () => {}, emitEvent: () => {} } });
mock.module("../host.js", { namedExports: {
  log: () => {}, retainSidecarSessions: async () => ({ closed: 0 }), windowSidecar: () => null,
} });
mock.module("../plugin-data.js", { namedExports: {
  configureData: () => {}, commitData: () => null, prepareData: async () => null, restoreData: () => {}, showData: async () => {},
} });
mock.module("../settings.js", { namedExports: {
  beginSettings: () => {}, selectProject: async () => {}, value: () => "tabs", flushSettings: async () => {},
} });
mock.module("../tab-state.js", { namedExports: {
  openTabStates: async ({ store }) => {
    if (store.failTabState) throw failure;
    return { reconcile: async () => {}, flush: async () => {} };
  },
} });
mock.module("../tab-session.js", { namedExports: {
  createTabSessions: () => ({ read: () => null, reconcile: async () => {}, flush: async () => {} }),
} });
mock.module("../document-regions.js", { namedExports: { documentRegions: { useSessions: () => {} } } });

globalThis.location = new URL("http://soksak.test/index.html");
globalThis.history = { replaceState: () => {} };
globalThis.dispatchEvent = () => true;

const projects = await import("../projects.js");
const successfulProjects = await import("../projects.js?tab-state-open-success");

test("a failed tab-state open rejects drawn placement waiters while the existing tried signal resolves", async () => {
  projects.begin({ common: {}, projects: [], open: [] });
  const store = {
    snapshot: async () => ({ common: {}, projects: [], open: [] }),
    onChange: () => {},
    failTabState: true,
  };
  const initialising = projects.initialise(store, () => true);
  const ready = projects.tabStatesOpened().then((result) => {
    if (!result.opened) throw result.error;
  });
  let observed = false;
  let placed = false;
  const saver = { place: () => { placed = true; return { surfaces: [], retain: new Set(), unload: [] }; } };
  const record = { drawn: true };
  const candidates = [{ id: "hidden-view", plugin: "probe" }];
  const waiters = [1, 2].map(() => memoryPlacement(record, candidates, {
    ready, saver, observe: () => { observed = true; },
  }));

  await assert.rejects(initialising, failure);
  assert.deepEqual(await projects.tabStatesOpened(), { opened: false, error: failure });
  await projects.tabStatesReady();
  const results = await Promise.allSettled(waiters);
  assert.deepEqual(results.map(({ status, reason }) => [status, reason]),
    [["rejected", failure], ["rejected", failure]], "tab-state open failure left a drawn placement pending");
  assert.equal(observed, false, "failed startup classified placement candidates");
  assert.equal(placed, false, "failed startup invoked memory saver placement");
});

test("a successful tab-state open resolves the placement readiness result", async () => {
  successfulProjects.begin({ common: {}, projects: [], open: [] });
  const store = {
    snapshot: async () => ({ common: {}, projects: [], open: [] }),
    onChange: () => {},
  };
  await successfulProjects.initialise(store, () => true);
  assert.deepEqual(await successfulProjects.tabStatesOpened(), { opened: true });
  await successfulProjects.tabStatesReady();
});
