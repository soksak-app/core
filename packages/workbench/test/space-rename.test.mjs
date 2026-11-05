// Renaming a space of the active project (core.space.rename): a known id takes the title, and an id that is no space of the project
// is an error that names it (docs/spec/projects.md#persistence).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 2, activeSpaceId: "spc-one",
  spaces: [
    { id: "spc-one", title: "SPACE1", layout: { state: { cards: [], name: "one" } } },
    { id: "spc-two", title: "SPACE2", layout: { state: { cards: [], name: "two" } } },
  ],
  settings: {},
};

mock.module("@soksak/runtime", {
  exports: {
    windows: {
      folder: async (root) => ({ root, identity: PROJECT.identity }),
      openProject: async () => ({ local: true }),
      projectShown: async () => {},
      releaseProject: async () => {},
      state: async () => null,
      close: async () => {},
      onRemoveProjectRequest: async () => {},
      askRemoveProject: async () => true,
      answerRemoveProject: async () => {},
      ready: async () => {},
      onActivate: async () => {},
      onCloseRequest: async () => {},
    },
  },
});
mock.module("../page-log.js", { exports: { flushEvents: async () => {}, emitEvent: () => {} } });
mock.module("../host.js", {
  exports: {
    log: () => {}, retainSidecarSessions: async () => ({ closed: 0 }), windowSidecar: () => null, documents: null, report: () => {},
  },
});
mock.module("../plugin-data.js", { exports: { configureData: () => {}, compareProjectData: () => {} } });
mock.module("../settings.js", {
  exports: { projectSidebars: () => ({ sets: [], links: [] }), beginSettings: async () => {}, selectProject: async () => {}, value: () => "tabs", flushSettings: async () => {} },
});
mock.module("../environment.js", { exports: { pluginUnits: () => [] } });

// The failures reported through the window error event.
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
globalThis.location = new URL("http://soksak.test/index.html");
globalThis.history = { replaceState: (state, title, url) => { globalThis.location = new URL(url, globalThis.location); } };

const projects = await import("../projects.js");

// A plane that holds the layout it loads.
const plane = { layout: null };
projects.onSwitch({
  check: () => {},
  save: () => plane.layout,
  load: (layout) => { plane.layout = layout; },
  update: () => {},
  retain: async () => {},
  presented: async () => {},
  settleTabs: async () => true,
  empty: async (show) => { plane.layout = null; show?.(); },
});

const patches = [];
const store = {
  snapshot: async () => ({ common: {}, projects: [structuredClone(PROJECT)], open: [] }),
  tabState: async () => null,
  tabStatePut: async () => 0,
  tabSession: async () => null,
  tabSessionPut: async () => null,
  tabSessions: async () => [],
  add: async () => { throw new Error("not used"); },
  patch: async (id, patch) => { patches.push({ id, patch }); },
  remove: async () => {},
  onChange: () => {},
};

test("a space of the active project takes its new title, and an unknown space id is an error that names it", async () => {
  await projects.initialise(store);
  await projects.activate(PROJECT.id);
  projects.renameSpace("spc-two", "Work");
  assert.deepEqual(projects.active().spaces.map((space) => [space.id, space.title]), [["spc-one", "SPACE1"], ["spc-two", "Work"]]);
  assert.throws(() => projects.renameSpace("spc-missing", "Notes"),
    (error) => error.constructor === Error && error.message === "Unknown space: spc-missing");
  assert.deepEqual(projects.active().spaces.map((space) => space.title), ["SPACE1", "Work"]);
  assert.deepEqual(reported, []);
});
