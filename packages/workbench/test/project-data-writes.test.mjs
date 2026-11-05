// Checks the writes of project data of a page against a store that answers later (docs/spec/plugins.md#project-data).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const stored = [{ id: "prj-alpha", root: "/work/alpha", identity: "alpha", title: "alpha", color: "#fff", named: 1,
  activeSpaceId: "spc-alpha", spaces: [{ id: "spc-alpha", title: "SPACE1", layout: { state: { cards: [] } } }], settings: {} }];
const project = { id: "prj-alpha", root: "/work/alpha" };

mock.module("@soksak/runtime", {
  namedExports: {
    windows: {
      folder: async (root) => ({ root, identity: "alpha" }),
      openProject: async () => ({ local: true, staged: true }),
      projectShown: async () => {},
      ready: async () => {},
      releaseProject: async () => {},
      state: async () => null,
      close: async () => {},
      onRemoveProjectRequest: async () => {},
      askRemoveProject: async () => true,
      answerRemoveProject: async () => {},
      onActivate: async () => {},
      onCloseRequest: async () => {},
    },
  },
});
mock.module("../page-log.js", { namedExports: { flushEvents: async () => {}, emitEvent: () => {} } });
mock.module("../host.js", {
  namedExports: { log: () => {}, retainSidecarSessions: async () => ({ closed: 0 }), windowSidecar: () => null,
    documents: null, report: () => {} },
});
mock.module("../settings.js", {
  namedExports: { projectSidebars: () => ({ sets: [], links: [] }), beginSettings: () => {}, selectProject: () => {},
    value: () => "tabs", flushSettings: async () => {} },
});
mock.module("../operations.js", { namedExports: { beginOperation: () => "operation" } });
mock.module("../tab-state.js", {
  namedExports: { openTabStates: async () => ({ reconcile: async () => {}, flush: async () => {} }) },
});
mock.module("../tab-session.js", {
  namedExports: { createTabSessions: () => ({ read: () => null, reconcile: async () => {}, flush: async () => {} }) },
});
mock.module("../document-regions.js", {
  namedExports: { documentRegions: { interaction: () => null, tabs: () => [], useSessions: () => {} } },
});
mock.module("../environment.js", { namedExports: { pluginUnits: () => [] } });

globalThis.dispatchEvent = () => true;
globalThis.location = new URL("http://soksak.test/index.html");
globalThis.history = { replaceState: () => {} };

const projects = await import("../projects.js");
const { declareProjectData, onDataChange, viewDataOf } = await import("../plugin-data.js");

projects.onSwitch({
  check: () => {},
  save: () => stored[0].spaces[0].layout,
  load: () => {},
  update: () => {},
  retain: async () => {},
  presented: async () => {},
  empty: async (show) => { show?.(); },
});

// The patches that the store took and has not answered, and the listener of its changes.
const patches = [];
let changedStore = () => {};
const store = {
  snapshot: async () => ({ common: {}, projects: structuredClone(stored), open: [] }),
  tabState: async () => null,
  tabStatePut: async () => 0,
  tabSession: async () => null,
  tabSessionPut: async () => null,
  tabSessions: async () => [],
  patch: (id, patch) => new Promise((resolve, reject) => { patches.push({ id, patch, resolve, reject }); }),
  add: async () => {},
  remove: async () => {},
  onChange: (fn) => { changedStore = fn; },
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Stores the oldest patch and answers it. */
async function answer() {
  const { patch, resolve } = patches.shift();
  stored[0].plugins = structuredClone(patch.plugins);
  resolve();
  await settle();
}

declareProjectData("probe", { first: { schema: { type: "string" }, default: "" }, second: { schema: { type: "string" }, default: "" },
  third: { schema: { type: "string" }, default: "" } });
projects.begin({ common: {}, projects: structuredClone(stored), open: [] });
await projects.initialise(store);
const data = () => viewDataOf(project, "probe");

test("two writes in a row keep both keys, and the store takes them in order", async () => {
  const first = data().set("first", "one");
  const second = data().set("second", "two");
  await settle();
  assert.equal(patches.length, 1, "the second write reached the store before the store answered the first");
  await answer();
  assert.equal(patches.length, 1, "the second write did not follow the answer of the first");
  await answer();
  await Promise.all([first, second]);
  assert.deepEqual(stored[0].plugins.probe, { first: { format: 1, value: "one" }, second: { format: 1, value: "two" } });
});

test("a read of the store that a write outran keeps the write", async () => {
  const heard = [];
  const stop = onDataChange((_project, _plugin, key) => heard.push(key));
  const third = data().set("third", "three");
  await settle();
  changedStore();
  await settle();
  assert.equal(data().get("third"), "three", "the read took the write back out of the project");
  assert.deepEqual(heard, [], "a view heard a change of a key that nobody changed");
  await answer();
  await third;
  assert.deepEqual(heard, ["third"]);
  stop();
});

test("a write that the store refuses answers the view and leaves the project as it was", async () => {
  const refused = data().set("first", "lost");
  await settle();
  assert.equal(data().get("first"), "lost");
  patches.shift().reject(new Error("the disk is full"));
  await assert.rejects(refused, /the disk is full/);
  assert.equal(data().get("first"), "one");
});

test("a refused write under a later write stays in the record of that later write", async () => {
  const refused = data().set("first", "kept");
  const later = data().set("second", "later");
  await settle();
  patches.shift().reject(new Error("the disk is full"));
  await assert.rejects(refused, /the disk is full/);
  await settle();
  assert.equal(data().get("first"), "kept");
  await answer();
  await later;
  assert.equal(stored[0].plugins.probe.first.value, "kept");
});
