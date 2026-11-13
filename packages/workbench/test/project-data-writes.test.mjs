// Checks the writes of project data of a page against a store that answers later (docs/spec/plugins.md#project-data).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";

const stored = [{ id: "prj-alpha", root: "/work/alpha", identity: "alpha", title: "alpha", color: "#fff", named: 1,
  activeSpaceId: "spc-alpha", spaces: [{ id: "spc-alpha", title: "SPACE1", layout: { state: { cards: [] } } }], settings: {} }];
const project = { id: "prj-alpha", root: "/work/alpha" };
// The stored values and bases that every host answers alike.
const VALUES = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/project-data/values.json", import.meta.url), "utf8"));

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
// The calls of store.patch and the answers, in order: a test compares this order in its negative checks.
const order = [];
// The number of calls of store.patch so far, and the waits that resolve when the number reaches their count.
let calls = 0;
let callWaits = [];
/** Resolves when store.patch has been called count times in all, at once when it has. */
const patchCalled = (count) => new Promise((resolve) => {
  if (calls >= count) resolve();
  else callWaits.push({ count, resolve });
});
let changedStore = () => {};
const store = {
  snapshot: async () => ({ common: {}, projects: structuredClone(stored), open: [] }),
  tabState: async () => null,
  tabStatePut: async () => 0,
  tabSession: async () => null,
  tabSessionPut: async () => null,
  tabSessions: async () => [],
  patch: (id, patch) => new Promise((resolve, reject) => {
    patches.push({ id, patch, resolve, reject });
    order.push("patch");
    calls += 1;
    callWaits = callWaits.filter((wait) => {
      if (calls < wait.count) return true;
      wait.resolve();
      return false;
    });
  }),
  add: async () => {},
  remove: async () => {},
  onChange: (fn) => { changedStore = fn; },
};

/** Stores the oldest patch and answers it. */
function answer() {
  const { patch, resolve } = patches.shift();
  stored[0].plugins = structuredClone(patch.plugins);
  order.push("answer");
  resolve();
}

declareProjectData("probe", { first: { schema: { type: "string" }, default: "" }, second: { schema: { type: "string" }, default: "" },
  third: { schema: { type: "string" }, default: "" } });
projects.begin({ common: {}, projects: structuredClone(stored), open: [] });
await projects.initialise(store);
const data = () => viewDataOf(project, "probe");

// contract: project-data.write.keeps-the-keys-before-it
test("two writes in a row keep both keys, and the store takes them in order", { timeout: 5000 }, async () => {
  const start = calls;
  order.length = 0;
  const first = data().set("first", "one");
  const second = data().set("second", "two");
  await patchCalled(start + 1);
  answer();
  await patchCalled(start + 2);
  answer();
  await Promise.all([first, second]);
  // The second write is sent only after the store answers the first one.
  assert.deepEqual(order, ["patch", "answer", "patch", "answer"], "the second write reached the store before the store answered the first");
  assert.deepEqual(stored[0].plugins.probe, { first: { format: 1, value: "one" }, second: { format: 1, value: "two" } });
});

// contract: project-data.write.outran-read-keeps-the-write
test("a read of the store that a write outran keeps the write", { timeout: 5000 }, async () => {
  const heard = [];
  const stop = onDataChange((_project, _plugin, key) => heard.push(key));
  const start = calls;
  const third = data().set("third", "three");
  await patchCalled(start + 1);
  changedStore();
  await projects.idle();
  assert.equal(data().get("third"), "three", "the read took the write back out of the project");
  assert.deepEqual(heard, [], "a view heard a change of a key that nobody changed");
  answer();
  await third;
  assert.deepEqual(heard, ["third"]);
  stop();
});

// contract: project-data.write.refusal-answers-the-view
test("a write that the store refuses answers the view and leaves the project as it was", { timeout: 5000 }, async () => {
  const start = calls;
  const refused = data().set("first", "lost");
  await patchCalled(start + 1);
  assert.equal(data().get("first"), "lost");
  patches.shift().reject(new Error("the disk is full"));
  await assert.rejects(refused, /the disk is full/);
  assert.equal(data().get("first"), "one");
});

test("a refused write under a later write stays in the record of that later write", { timeout: 5000 }, async () => {
  const start = calls;
  const refused = data().set("first", "kept");
  const later = data().set("second", "later");
  await patchCalled(start + 1);
  patches.shift().reject(new Error("the disk is full"));
  await assert.rejects(refused, /the disk is full/);
  await patchCalled(start + 2);
  assert.equal(data().get("first"), "kept");
  answer();
  await later;
  assert.equal(stored[0].plugins.probe.first.value, "kept");
});

// contract: project-data.replace.changed-value-writes-nothing
test("two replaces from one read keep the first, and the second answers false and writes nothing", { timeout: 5000 }, async () => {
  const start = calls;
  order.length = 0;
  const base = data().get("third");
  const first = data().replace("third", base, "first change");
  const second = data().replace("third", base, "second change");
  // A refused replace settles at its call, so it is the first of the race; a replace that waits for the store is not settled yet.
  assert.equal(await Promise.race([second, Promise.resolve("pending")]), false, "the second replace waited for the store");
  await patchCalled(start + 1);
  answer();
  assert.equal(await first, true);
  // The second replace would be a second patch after the answer; the order holds only the first patch and its answer.
  assert.deepEqual(order, ["patch", "answer"], "the second replace reached the store");
  assert.equal(data().get("third"), "first change");
});

/** Stores the JSON text of a value of the key point, as a host answers it, and lets the window read it. */
async function storePoint(text) {
  stored[0].plugins = { ...stored[0].plugins, ordered: { point: { format: 1, value: JSON.parse(text) } } };
  changedStore();
  await projects.idle();
}

// contract: project-data.replace.compares-json-values
test("a replace compares JSON values, whatever the form of their text", { timeout: 5000 }, async () => {
  declareProjectData("ordered", { point: { schema: { type: "object" }, default: {} } });
  const ordered = viewDataOf(project, "ordered");
  for (const { stored: text, base, same } of VALUES) {
    await storePoint(text);
    const start = calls;
    const replaced = ordered.replace("point", JSON.parse(base), { next: 1 });
    if (same) {
      await patchCalled(start + 1);
      answer();
    }
    assert.equal(await replaced, same, `${text} against ${base}`);
  }
});

// contract: project-data.replace.read-value-is-its-base
test("the value that a read answered is a base that a replace accepts", { timeout: 5000 }, async () => {
  const ordered = viewDataOf(project, "ordered");
  for (const { stored: text } of VALUES) {
    await storePoint(text);
    const start = calls;
    const replaced = ordered.replace("point", JSON.parse(JSON.stringify(ordered.get("point"))), { next: 1 });
    await patchCalled(start + 1);
    answer();
    assert.equal(await replaced, true, text);
  }
});

// contract: project-data.replace.refusal-answers-the-view
test("a replace that the store refuses answers the view and leaves the value", { timeout: 5000 }, async () => {
  const start = calls;
  const before = data().get("third");
  const refused = data().replace("third", before, "lost");
  await patchCalled(start + 1);
  patches.shift().reject(new Error("the disk is full"));
  await assert.rejects(refused, /the disk is full/);
  assert.equal(data().get("third"), before);
});
