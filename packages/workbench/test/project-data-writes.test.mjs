// Checks the writes of project data of a page against a store that answers later (docs/spec/plugins.md#project-data).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";

const stored = [{ id: "prj-alpha", root: "/work/alpha", identity: "alpha", title: "alpha", color: "#fff", named: 1,
  activeSpaceId: "spc-alpha", spaces: [{ id: "spc-alpha", title: "SPACE1", layout: { state: { cards: [] } } }], settings: {} }];
const project = { id: "prj-alpha", root: "/work/alpha" };
// The stored values and bases that every host answers alike.
const VALUES = JSON.parse(readFileSync(new URL("fixtures/project-data-values.json", import.meta.url), "utf8"));

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

// contract: project-data.write.keeps-the-keys-before-it
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

// contract: project-data.write.outran-read-keeps-the-write
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

// contract: project-data.write.refusal-answers-the-view
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

// contract: project-data.replace.changed-value-writes-nothing
test("two replaces from one read keep the first, and the second answers false and writes nothing", async () => {
  const base = data().get("third");
  const first = data().replace("third", base, "first change");
  const second = data().replace("third", base, "second change");
  assert.equal(await second, false);
  await settle();
  assert.equal(patches.length, 1, "the second replace reached the store");
  await answer();
  assert.equal(await first, true);
  assert.equal(data().get("third"), "first change");
});

/** Stores the JSON text of a value of the key point, as a host answers it, and lets the window read it. */
async function storePoint(text) {
  stored[0].plugins = { ...stored[0].plugins, ordered: { point: { format: 1, value: JSON.parse(text) } } };
  changedStore();
  await settle();
}

// contract: project-data.replace.compares-json-values
test("a replace compares JSON values, whatever the form of their text", async () => {
  declareProjectData("ordered", { point: { schema: { type: "object" }, default: {} } });
  const ordered = viewDataOf(project, "ordered");
  for (const { stored: text, base, same } of VALUES) {
    await storePoint(text);
    const replaced = ordered.replace("point", JSON.parse(base), { next: 1 });
    await settle();
    if (same) await answer();
    assert.equal(await replaced, same, `${text} against ${base}`);
  }
});

// contract: project-data.replace.read-value-is-its-base
test("the value that a read answered is a base that a replace accepts", async () => {
  const ordered = viewDataOf(project, "ordered");
  for (const { stored: text } of VALUES) {
    await storePoint(text);
    const replaced = ordered.replace("point", JSON.parse(JSON.stringify(ordered.get("point"))), { next: 1 });
    await settle();
    await answer();
    assert.equal(await replaced, true, text);
  }
});

// contract: project-data.replace.refusal-answers-the-view
test("a replace that the store refuses answers the view and leaves the value", async () => {
  const before = data().get("third");
  const refused = data().replace("third", before, "lost");
  await settle();
  patches.shift().reject(new Error("the disk is full"));
  await assert.rejects(refused, /the disk is full/);
  assert.equal(data().get("third"), before);
});
