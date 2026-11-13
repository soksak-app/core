// Checks that opening the library and switching a project finish in the order they were received.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 1,
  activeSpaceId: "spc-one", spaces: [{ id: "spc-one", title: "SPACE1", layout: { state: { cards: [], name: "one" } } }], settings: {},
};

// The geometry that the window reports.
let windowGeometry = null;
// The project that received the window open request.
const openRequests = [];
mock.module("@soksak/runtime", {
  namedExports: {
    windows: {
      folder: async (root) => {
        if (root === "/work/missing") throw new Error("project directory does not exist: /work/missing");
        return { root, identity: PROJECT.identity };
      },
      openProject: async (request) => { openRequests.push(request.id); return { local: true }; },
      projectShown: async () => {},
      releaseProject: async () => {},
      state: async () => windowGeometry,
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
// Records the calls that clean up sidecar sessions.
// The page event queue drains before a window closes; the queue of this test holds no events.
mock.module("../page-log.js", {
  namedExports: { flushEvents: async () => {}, emitEvent: () => {} },
});
const retained = [];
let retentionFailure = null;
mock.module("../host.js", {
  namedExports: {
    log: () => {},
    retainSidecarSessions: async (surfaces) => {
      retained.push(surfaces);
      if (retentionFailure) throw retentionFailure;
      return { closed: 0 };
    },
    windowSidecar: () => null,
    documents: null,
    report: () => {},
  },
});
let dataOptions = null;
mock.module("../plugin-data.js", {
  namedExports: {
    configureData: (values) => { dataOptions = values; },
    compareProjectData: () => {},
  },
});
/* The project that the first screen chose for the settings. */
const begunSettings = [];
let beginThemeReply = async () => {};
/* The host reply of the settings project selection. The test can hold the reply. */
let selection = async () => {};
mock.module("../settings.js", {
  namedExports: {
    beginSettings: (snapshot, id) => { begunSettings.push(id); return beginThemeReply(snapshot, id); },
    selectProject: () => selection(),
    value: () => "tabs",
    projectSidebars: (project) => project.sidebarsOfTest ?? { sets: [], links: [] },
    flushSettings: async () => {},
  },
});

// The document global that the project module uses. It records the failures reported through the window error event.
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
globalThis.location = new URL("http://soksak.test/index.html");
globalThis.history = { replaceState: (state, title, url) => { globalThis.location = new URL(url, globalThis.location); } };

mock.module("../environment.js", { namedExports: {
  pluginUnits: () => [{ id: "retained-probe", surface: { composition: { kind: "view" } } }],
} });

const projects = await import("../projects.js");
const { registerSection } = await import("../registry.js");

/**
 * A recorder that acts as the plane. A clear after hold() does not finish until release(). The test rejects a rejected layout.
 * The drawing of a clear erases the plane and runs the screen drawing it received (show). drawing is true during that drawing.
 */
const plane = { layout: null, events: [], gate: Promise.resolve(), rejected: null, drawing: false };
// The writing path that each layout save names (docs/spec/projects.md#tab-origin).
const saves = [];
plane.hold = () => {
  plane.gate = new Promise((resolve) => { plane.release = resolve; });
};
// Resolves when the next plane clear starts (plane.empty).
let clearStarted = null;
const emptyStarts = () => new Promise((resolve) => { clearStarted = resolve; });
projects.onSwitch({
  check: (layout) => { if (layout === plane.rejected) throw new Error("fixture layout cannot be opened"); },
  save: (path) => {
    saves.push(path);
    if (plane.layout === null) throw new Error("the plane has no layout to save");
    return plane.layout;
  },
  load: (layout) => { plane.layout = layout; plane.events.push("load"); },
  update: () => {},
  // Cleans up the surface modules outside the tabs of the remaining layout. It also records the order relative to the session cleanup in retained.
  retain: async (surfaceIds) => { retained.push({ modules: [...surfaceIds] }); },
  presented: async () => {},
  // The plane of this test holds no modified tab.
  settleTabs: async () => true,
  empty: async (show) => {
    plane.events.push("empty started");
    clearStarted?.();
    await plane.gate;
    plane.drawing = true;
    plane.layout = null;
    show?.();
    plane.drawing = false;
    plane.events.push("emptied");
  },
});

const store = {
  snapshot: async () => ({ common: {}, projects: [structuredClone(PROJECT)], open: [] }),
  // The tab state store holds no entry.
  tabState: async () => null,
  tabStatePut: async () => 0,
  // The tab sessions hold no file.
  tabSession: async () => null,
  tabSessionPut: async () => null,
  tabSessions: async () => [],
  add: async () => { throw new Error("not used"); },
  patch: async () => {},
  remove: async () => {},
  onChange: () => {},
};

test("opening a project while the library is still clearing the plane loads it after the clearing", { timeout: 5000 }, async () => {
  await projects.initialise(store);
  await projects.activate(PROJECT.id);
  assert.deepEqual(plane.layout, PROJECT.spaces[0].layout);

  plane.events.length = 0;
  plane.hold();
  const emptying = emptyStarts();
  const browsing = projects.browse();
  const opening = projects.activate(PROJECT.id);
  // The clear holds the plane until the release. The mark of the release is in the order, so the load must follow it.
  await emptying;
  plane.events.push("released");
  plane.release();
  await Promise.all([browsing, opening]);
  assert.deepEqual(plane.events, ["empty started", "released", "emptied", "load"], "the project was loaded while the plane was being cleared");
  assert.deepEqual(plane.layout, PROJECT.spaces[0].layout);
  await projects.flush();
});

test("plugin states follow the shown project and project data is patched under plugins", async () => {
  const patches = [];
  await projects.initialise({ ...store, patch: async (id, patch) => { patches.push([id, patch]); } });
  await projects.browse();
  await projects.activate(PROJECT.id);
  await projects.browse();
  await projects.activate(PROJECT.id);
  assert.deepEqual(dataOptions.data.get(PROJECT.id, "probe"), {});
  await dataOptions.data.set(PROJECT.id, "probe", "marks", ["a"]);
  assert.deepEqual(patches.at(-1), [PROJECT.id, { plugins: { probe: { marks: ["a"] } } }]);
  assert.deepEqual(dataOptions.data.get(PROJECT.id, "probe"), { marks: ["a"] });
  await projects.flush();
});

test("a flush writes the window geometry only when it changed", async () => {
  const patches = [];
  await projects.initialise({ ...store, patch: async (id, patch) => { if (patch.geometry) patches.push(patch.geometry); } });
  await projects.browse();
  await projects.activate(PROJECT.id);
  windowGeometry = { x: 1, y: 2, width: 300, height: 200 };
  try {
    await projects.flush();
    await projects.flush();
    assert.deepEqual(patches, [windowGeometry], "an unchanged geometry was written again");
    windowGeometry = { x: 5, y: 2, width: 300, height: 200 };
    await projects.flush();
    assert.equal(patches.length, 2, "a changed geometry was not written");
  } finally {
    windowGeometry = null;
  }
});

test("the surfaces of every layout are listed with their project root, and removing a project retains the rest", async () => {
  const layout = { state: { cards: [
    { id: "left" },
    { id: "right", data: { tabs: [{ id: "tab-a", plugin: "fixture" }, { id: "tab-b", plugin: "fixture" }] } },
  ] } };
  const two = {
    ...structuredClone(PROJECT), id: "prj-two", root: "/work/two",
    spaces: [{ id: "spc-two", title: "SPACE1", layout }],
  };
  const one = { ...structuredClone(PROJECT), id: "prj-three" };
  one.spaces[0].layout = { state: { cards: [{ id: "one", data: { tabs: [{ id: "tab-one", plugin: "beta" }] } }] } };
  let listed = [one, two];
  const local = { ...store, snapshot: async () => ({ common: {}, projects: listed.map((item) => structuredClone(item)), open: [] }),
    remove: async (id) => { listed = listed.filter((item) => item.id !== id); } };
  await projects.initialise(local);
  assert.deepEqual(projects.layoutSurfaces(), [
    { surface: "tab-one", plugin: "beta", root: "/work/one" },
    { surface: "tab-a", plugin: "fixture", root: "/work/two" },
    { surface: "tab-b", plugin: "fixture", root: "/work/two" },
  ]);
  retained.length = 0;
  await projects.close("prj-two");
  // It cleans up the surface modules of the deleted project first. If a module remains, it reopens the finished session in the deleted folder (F44).
  assert.deepEqual(retained, [{ modules: ["tab-one"] }, [{ surface: "tab-one", plugin: "beta", root: "/work/one" }]],
    "removing a project disposes the surface modules of its tabs before it ends their sidecar sessions");
  listed[0].spaces[0].layout = { state: {} };
  reported.length = 0;
  await projects.initialise(local);
  assert.deepEqual(reported, ["project prj-three space spc-one has no layout cards"],
    "the reconciliation of the tab state store reports a layout without cards and keeps the entries");
  reported.length = 0;
  assert.throws(() => projects.layoutSurfaces(), /has no layout cards/, "a layout without cards is an explicit error");
});

test("the layouts hold the sections of every space of every project, whatever the window draws, with the sets of each project", async () => {
  // Each section names the plugin that declares it, and a section that no loaded plugin declares (gone.list) has no surface.
  for (const [id, plugin] of [["alpha.tree", "alpha"], ["alpha.bookmarks", "alpha"], ["other.list", "other"]]) {
    registerSection({ id, name: id, plugin, surface: { composition: { kind: "view" } } });
  }
  const card = { id: "crd", data: { tabs: [{ id: "tab-x", plugin: "beta" }], activeId: "tab-x", sidebars: { left: { set: "own" } } } };
  const sets = (first) => ({
    sets: [{ id: first, sections: ["alpha.tree", "gone.list"] }, { id: "own", sections: ["alpha.bookmarks"] }],
    links: [{ place: "left", plugin: null, set: first }],
  });
  const listed = [
    { ...structuredClone(PROJECT), id: "prj-a", root: "/work/a", sidebarsOfTest: sets("first"), spaces: [
      { id: "spc-a1", title: "SPACE1", layout: { state: { cards: [structuredClone(card)] } } },
      { id: "spc-a2", title: "SPACE2", layout: { state: { cards: [] } } },
    ], activeSpaceId: "spc-a1" },
    { ...structuredClone(PROJECT), id: "prj-b", root: "/work/b", sidebarsOfTest: { sets: [{ id: "only", sections: ["other.list"] }], links: [{ place: "window-right", plugin: "beta", set: "only" }] },
      spaces: [{ id: "spc-b", title: "SPACE1", layout: { state: { cards: [] } } }], activeSpaceId: "spc-b" },
  ];
  await projects.initialise({ ...store, snapshot: async () => ({ common: {}, projects: structuredClone(listed), open: [] }) });
  assert.deepEqual(projects.layoutSurfaces(), [
    { surface: "tab-x", plugin: "beta", root: "/work/a" },
    { surface: "spc-a1/left/alpha.tree", plugin: "alpha", root: "/work/a" },
    { surface: "spc-a1/crd:left/alpha.bookmarks", plugin: "alpha", root: "/work/a" },
    { surface: "spc-a2/left/alpha.tree", plugin: "alpha", root: "/work/a" },
    { surface: "spc-b/right/other.list", plugin: "other", root: "/work/b" },
  ]);
});

test("a saved layout that fails the plane check rejects the open before any project or window change", async () => {
  const patches = [];
  const other = { ...structuredClone(PROJECT), id: "prj-bad", root: "/work/bad",
    spaces: [{ id: "spc-bad", title: "SPACE1", layout: { state: { cards: [], name: "bad" } } }], activeSpaceId: "spc-bad" };
  const listed = [structuredClone(PROJECT), other];
  await projects.initialise({ ...store, snapshot: async () => ({ common: {}, projects: listed.map((item) => structuredClone(item)), open: [] }),
    patch: async (id, patch) => { patches.push([id, patch]); } });
  await projects.activate(PROJECT.id);
  const shown = plane.layout;
  plane.rejected = projects.all().find((item) => item.id === "prj-bad").spaces[0].layout;
  patches.length = 0;
  openRequests.length = 0;
  plane.events.length = 0;
  await assert.rejects(projects.activate("prj-bad"), /fixture layout cannot be opened/);
  assert.equal(projects.active().id, PROJECT.id, "the rejected open replaced the active project");
  assert.deepEqual(openRequests, [], "the rejected open asked the host for a window");
  assert.deepEqual(patches.filter(([id]) => id === "prj-bad"), [], "the rejected open changed the saved record");
  assert.deepEqual(plane.events, [], "the rejected open replaced the plane");
  assert.equal(plane.layout, shown);
  await projects.flush();
  // This caller, which received the rejection, reports the rejected open. The switch sequence does not report the same failure again as a window error (G1.4-113).
  assert.deepEqual(reported, [], "the rejected open was reported again as a window error");
  plane.rejected = null;
  await projects.flush();
});

test("opening a project whose folder cannot be read rejects with the host's message", async () => {
  const missing = { ...structuredClone(PROJECT), id: "prj-missing", root: "/work/missing" };
  await projects.initialise({ ...store, snapshot: async () => ({ common: {}, projects: [structuredClone(PROJECT), structuredClone(missing)], open: [] }),
    patch: async () => {} });
  openRequests.length = 0;
  reported.length = 0;
  await assert.rejects(projects.activate("prj-missing"),
    { message: "project directory does not exist: /work/missing" });
  assert.deepEqual(openRequests, [], "the failed open asked the host for a window");
  // The caller that received the rejection reports the failure once. The switch sequence does not report the same failure again as a window error (G1.4-113).
  await projects.flush();
  assert.deepEqual(reported, [], "the failed switch was reported again as a window error");
});

test("switching to or closing into a space that fails the plane check changes neither the active space nor the plane", async () => {
  // The project that this window owns keeps its space in memory, so the test uses a different project from the earlier tests.
  const project = { ...structuredClone(PROJECT), id: "prj-spaces", root: "/work/spaces", spaces: [
    { id: "spc-one", title: "SPACE1", layout: { state: { cards: [], name: "one" } } },
    { id: "spc-bad", title: "SPACE2", layout: { state: { cards: [], name: "bad" } } },
  ] };
  await projects.initialise({ ...store, snapshot: async () => ({ common: {}, projects: [structuredClone(project)], open: [] }) });
  await projects.activate(project.id);
  plane.rejected = projects.active().spaces[1].layout;
  plane.events.length = 0;
  assert.throws(() => projects.activateSpace("spc-bad"), /fixture layout cannot be opened/);
  assert.equal(projects.active().activeSpaceId, "spc-one", "the rejected switch changed the active space");
  // Closing the active space moves to the next space. If that space fails in the test, the close fails too.
  assert.throws(() => projects.closeSpace("spc-one"), /fixture layout cannot be opened/);
  assert.deepEqual(projects.active().spaces.map((space) => space.id), ["spc-one", "spc-bad"], "the rejected close removed a space");
  assert.equal(projects.active().activeSpaceId, "spc-one");
  assert.deepEqual(plane.events, [], "the rejected switch replaced the plane");
  plane.rejected = null;
  await projects.flush();
});

test("the start document draws the window's project before the store connects and the activation resumes it", async () => {
  const { windows } = await import("@soksak/runtime");
  const state = windows.state;
  windows.state = async () => ({ x: 1, y: 2, width: 300, height: 200 });
  const project = { ...structuredClone(PROJECT), id: "prj-begin", root: "/work/begin" };
  const snapshot = { common: {}, projects: [structuredClone(project)], open: [] };
  globalThis.location = new URL(`http://soksak.test/index.html?project=${project.id}`);
  plane.events.length = 0;
  begunSettings.length = 0;
  projects.begin(structuredClone(snapshot));
  assert.equal(projects.active().id, project.id);
  assert.equal(projects.inLibrary(), false);
  assert.deepEqual(plane.events, ["load"], "the first screen did not draw the project's space");
  assert.deepEqual(begunSettings, [project.id], "the first screen did not apply the project's settings");
  const patches = [];
  openRequests.length = 0;
  await projects.initialise({ ...store, snapshot: async () => structuredClone(snapshot), patch: async (id, patch) => { patches.push([id, Object.keys(patch)]); } });
  windows.state = state;
  assert.deepEqual(openRequests, [project.id], "the activation did not open the project's window");
  assert.deepEqual(patches, [[project.id, ["lastOpened"]]], "the activation saved more than the open time");
  assert.equal(projects.active().id, project.id);
  await projects.flush();
});

test("the start document draws the project synchronously while the host theme reply is pending", { timeout: 5000 }, async () => {
  const project = { ...structuredClone(PROJECT), id: "prj-theme-start", root: "/work/theme-start" };
  const snapshot = { common: {}, projects: [structuredClone(project)], open: [] };
  globalThis.location = new URL(`http://soksak.test/index.html?project=${project.id}`);
  let acknowledge;
  beginThemeReply = () => new Promise((resolve) => { acknowledge = resolve; });
  plane.events.length = 0;

  projects.begin(structuredClone(snapshot));
  assert.deepEqual(plane.events, ["load"], "the first DOM layout waited for the host theme reply");
  acknowledge();
  beginThemeReply = async () => {};
});

test("a project whose settings file the host refused is not opened, and the start shows the library with the error", async () => {
  const error = "/work/refused/.soksak/settings.json: settings.json: format must be 1";
  const refused = { ...structuredClone(PROJECT), id: "prj-refused", root: "/work/refused", settingsError: error };
  delete refused.settings;
  const snapshot = { common: {}, projects: [structuredClone(PROJECT), structuredClone(refused)], open: [] };
  globalThis.location = new URL(`http://soksak.test/index.html?project=${refused.id}`);
  begunSettings.length = 0;
  plane.events.length = 0;
  reported.length = 0;
  projects.begin(structuredClone(snapshot));
  assert.equal(projects.active(), null, "the first screen drew the project whose settings file was refused");
  assert.deepEqual(begunSettings, [null], "the settings began with the project whose settings file was refused");
  openRequests.length = 0;
  await projects.initialise({ ...store, snapshot: async () => structuredClone(snapshot), patch: async () => {} });
  assert.equal(projects.active(), null);
  assert.equal(projects.inLibrary(), true);
  assert.deepEqual(openRequests, [], "the refused project asked the host for a window");
  assert.deepEqual(reported, [error], "the start did not report the refused settings file once");
  await assert.rejects(projects.activate(refused.id), { message: error });
  assert.deepEqual(openRequests, [], "the refused open asked the host for a window");
  // The other project opens.
  await projects.activate(PROJECT.id);
  assert.equal(projects.active().id, PROJECT.id);
  await projects.flush();
});

test("a project that the start document drew falls back to the library when its activation fails", async () => {
  const missing = { ...structuredClone(PROJECT), id: "prj-gone", root: "/work/missing" };
  const snapshot = { common: {}, projects: [structuredClone(missing)], open: [] };
  globalThis.location = new URL(`http://soksak.test/index.html?project=${missing.id}`);
  projects.begin(structuredClone(snapshot));
  assert.equal(projects.active().id, missing.id);
  plane.events.length = 0;
  reported.length = 0;
  await projects.initialise({ ...store, snapshot: async () => structuredClone(snapshot), patch: async () => {} });
  assert.equal(projects.active(), null);
  assert.equal(projects.inLibrary(), true);
  assert.deepEqual(plane.events, ["empty started", "emptied"]);
  assert.equal(globalThis.location.search, "");
  assert.deepEqual(reported, ["project directory does not exist: /work/missing"], "the failed start activation was not reported once");
});

test("a project removed from the registry by another window ends in the window that shows it as closing its tab does", { timeout: 5000 }, async () => {
  /** A project with one tab in one card. */
  const project = (id, tab) => ({ ...structuredClone(PROJECT), id, root: `/work/${id}`, spaces: [
    { id: `spc-${id}`, title: "SPACE1", layout: { state: { cards: [{ id: `card-${id}`, data: { tabs: [{ id: tab, plugin: "fixture" }] } }] } } },
  ], activeSpaceId: `spc-${id}` });
  let listed = [project("prj-shown", "tab-shown"), project("prj-next", "tab-next"), project("prj-other", "tab-other")];
  let notify = null;
  const patches = [];
  await projects.initialise({ ...store,
    snapshot: async () => ({ common: {}, projects: listed.map((item) => structuredClone(item)), open: [] }),
    patch: async (id, patch) => { patches.push(id); },
    onChange: (fn) => { notify = fn; } });
  reported.length = 0;
  // This window shows two projects as tabs, and prj-shown is active. prj-other is the project of another window.
  await projects.activate("prj-next");
  await projects.activate("prj-shown");
  // Another window deletes prj-shown, and the store notifies this window of the change. projects.idle resolves when the handling of the notification has finished.
  const removeElsewhere = async (id) => {
    listed = listed.filter((item) => item.id !== id);
    retained.length = 0;
    patches.length = 0;
    plane.events.length = 0;
    notify();
    await projects.idle();
  };
  await removeElsewhere("prj-shown");
  assert.equal(projects.all().some((item) => item.id === "prj-shown"), false);
  assert.equal(projects.active()?.id, "prj-next", "the window did not open its next project as closing the project tab does");
  assert.deepEqual(retained.slice(0, 2), [
    { modules: ["tab-next", "tab-other"] },
    [{ surface: "tab-next", plugin: "fixture", root: "/work/prj-next" }, { surface: "tab-other", plugin: "fixture", root: "/work/prj-other" }],
  ], "the window kept the surface modules and sidecar sessions of the removed project's tabs");
  assert.equal(patches.includes("prj-shown"), false, "the window saved the removed project");
  await removeElsewhere("prj-next");
  assert.equal(projects.active(), null);
  assert.equal(projects.inLibrary(), true, "the window without a project did not show the library");
  assert.deepEqual(projects.local(), []);
  assert.deepEqual(retained, [{ modules: ["tab-other"] }, [{ surface: "tab-other", plugin: "fixture", root: "/work/prj-other" }]],
    "the window kept the surface modules and sidecar sessions of its last removed project");
  assert.deepEqual(reported, [], "ending the removed project reported an error");
  await projects.flush();
});

test("an activation received while a removed project is clearing waits for the clear", { timeout: 5000 }, async () => {
  const project = (id, tab) => ({ ...structuredClone(PROJECT), id, root: `/work/${id}`, spaces: [
    { id: `spc-${id}`, title: "SPACE1", layout: { state: { cards: [{ id: `card-${id}`, data: { tabs: [{ id: tab, plugin: "fixture" }] } }] } } },
  ], activeSpaceId: `spc-${id}` });
  const removed = project("prj-clearing-removed", "tab-clearing-removed");
  const next = project("prj-clearing-next", "tab-clearing-next");
  let listed = [removed, next];
  let notify = null;
  await projects.initialise({ ...store,
    snapshot: async () => ({ common: {}, projects: listed.map((item) => structuredClone(item)), open: [] }),
    onChange: (fn) => { notify = fn; },
  });
  await projects.activate(removed.id);

  plane.events.length = 0;
  plane.hold();
  listed = [next];
  const emptying = emptyStarts();
  notify();
  await emptying;
  assert.deepEqual(plane.events, ["empty started"], "removal did not begin clearing the active project");

  // The step runner sees the activation start its wait for the turn before it. A race of that turn against a resolved mark answers
  // the turn when it had already ended and the mark while it is pending, because the reaction of a settled promise is queued first.
  const pending = Symbol("pending");
  let turnWaited;
  const turnStarted = new Promise((resolve) => { turnWaited = resolve; });
  projects.runSteps(async (step, work) => {
    const result = work();
    if (step === "projects.turn") {
      const state = await Promise.race([result, Promise.resolve(pending)]);
      plane.events.push(state === pending ? "turn waits for the clear" : "turn did not wait");
      turnWaited();
    }
    return result;
  });
  try {
    const activation = projects.activate(next.id);
    await turnStarted;
    plane.events.push("released");
    plane.release();
    await activation;
    await projects.idle();
  } finally {
    projects.runSteps(null);
  }

  assert.deepEqual(plane.events, ["empty started", "turn waits for the clear", "released", "emptied", "load"],
    "the removed-project clear ran after the replacement project was loaded");
  assert.equal(projects.active()?.id, next.id);
  assert.equal(projects.inLibrary(), false);
  await projects.flush();
});

// WebKit runs the reaction of a promise that the host reply fulfilled at the next microtask checkpoint, and that checkpoint can come after the ResizeObserver callback of the next
// rendering update. If the switch to the library happens in that reaction, elements of the work area that the observation round
// already delivered (the file tree, the terminal screen) become 0x0 and a loop error occurs (F43). The switch must happen in the drawing that clears the plane,
// that is, in the next task, which runs outside the observation round.
test("browsing shows the library in the draw that empties the plane, not where a later host reply resolves", { timeout: 5000 }, async () => {
  await projects.initialise(store);
  await projects.activate(PROJECT.id);
  let screen = "workspace";
  let inRound = false;
  const switches = [];
  projects.onChange(() => {
    const next = projects.inLibrary() ? "library" : "workspace";
    if (next !== screen) switches.push(`${next} in ${plane.drawing ? "the empty draw" : inRound ? "the observation round" : "a task"}`);
    screen = next;
  });
  // The host reply of the settings project selection is fulfilled at the checkpoint after the callback of the file tree observer.
  const reply = Promise.withResolvers();
  const asked = Promise.withResolvers();
  selection = () => { asked.resolve(); return reply.promise; };
  try {
    const browsing = projects.browse();
    await asked.promise;
    // Observation round: the tree callback runs, and the held reply is fulfilled at that checkpoint.
    inRound = true;
    reply.resolve();
    await browsing;
    inRound = false;
    assert.deepEqual(switches, ["library in the empty draw"], "the library screen was not drawn by the draw that empties the plane");
  } finally {
    selection = async () => {};
    projects.onChange(() => {});
  }
  await projects.flush();
  // The window still owns the project after browsing, and an owned project keeps its in-memory layout over the next
  // snapshot; removing the project ends that ownership, so a later check reads the layout of its own snapshot.
  assert.equal(await projects.close(PROJECT.id), true, "the project that the check opened was not removed");
  assert.equal(projects.local().length, 0, "the window still owns a project after the check");
});

test("closing a tab removes its session file after the layout write, and the start removes the files of tabs in no layout", async () => {
  const layout = (...tabs) => ({ state: { cards: [{ id: "card-one", data: { tabs: tabs.map((id) => ({ id, plugin: "fixture" })) } }] } });
  const project = { ...structuredClone(PROJECT), spaces: [{ id: "spc-one", title: "SPACE1", layout: layout("tab-a", "tab-b") }] };
  const puts = [];
  plane.layout = layout("tab-a", "tab-b");
  await projects.initialise({ ...store,
    snapshot: async () => ({ common: {}, projects: [structuredClone(project)], open: [] }),
    tabSessions: async () => ["tab-gone"],
    tabSessionPut: async (tab, regions) => { puts.push([tab, regions]); return null; } });
  assert.deepEqual(puts, [["tab-gone", null]], "the start kept the session file of a tab in no layout");
  await projects.activate("prj-one");
  puts.length = 0;
  retained.length = 0;
  plane.layout = layout("tab-b");
  await projects.keep();
  assert.deepEqual(puts, [["tab-a", null]], "closing a tab left its session file");
  assert.deepEqual(retained, [[{ surface: "tab-b", plugin: "fixture", root: "/work/one" }]],
    "closing the last layout occurrence did not retain only the remaining project surfaces");
  await projects.flush();

  reported.length = 0;
  retentionFailure = new Error("fixture retain failure");
  plane.layout = layout("tab-c");
  await assert.rejects(projects.keep(), /fixture retain failure/,
    "a rejected retain operation was reported as a successful layout save");
  assert.deepEqual(reported, ["fixture retain failure"], "the retain failure was not reported exactly once");
  retentionFailure = null;
  await projects.flush();
});

test("a refused layout write answers its caller, and the next layout write and the same layout reach the store", async () => {
  const written = [];
  let refusals = 0;
  plane.layout = PROJECT.spaces[0].layout;
  await projects.initialise({ ...store, patch: async (id, patch) => {
    if (refusals > 0 && patch.spaces) {
      refusals -= 1;
      throw new Error("the disk is full");
    }
    if (patch.spaces) written.push(patch.spaces[0].layout.state.name);
  } });
  await projects.activate(PROJECT.id);
  const named = (name) => ({ state: { ...PROJECT.spaces[0].layout.state, name } });
  written.length = 0;
  refusals = 1;
  plane.layout = named("refused");
  await assert.rejects(projects.keep(), /the disk is full/);
  await projects.keep();
  assert.deepEqual(written, ["refused"], "the refused layout was not written again");
  plane.layout = named("later");
  await projects.keep();
  assert.deepEqual(written, ["refused", "later"], "a write after a refused write did not reach the store");
  assert.equal(await projects.close(PROJECT.id), true);
});

test("each layout save names its writing path: add space for a new space of the shown project", async () => {
  saves.length = 0;
  await projects.initialise(store);
  await projects.activate(PROJECT.id);
  projects.addSpace(PROJECT.spaces[0].layout);
  assert.equal(saves.at(-1), "add space");
  assert.ok(saves.every((path) => typeof path === "string"), "a save names its writing path");
});



test("a reopened project restores inactive-space origins before retained views can start", { timeout: 5000 }, async () => {
  const { tabOrigin } = await import("../tab-reports.js");
  const project = structuredClone(PROJECT);
  project.id = "project-retained-origin";
  project.spaces.push({ id: "space-retained-origin", title: "Hidden", layout: {
    state: { cards: [{ id: "hidden-card", data: {
      activeId: "tab-retained-origin", tabs: [{ id: "tab-retained-origin", plugin: "retained-probe",
        origin: { directory: "/work/retained-source" } }],
    } }] },
  } });
  const snapshot = { common: {}, projects: [project], open: [] };
  globalThis.location = new URL(`http://soksak.test/index.html?project=${project.id}`);
  projects.begin(structuredClone(snapshot));
  await projects.initialise({ ...store, snapshot: async () => structuredClone(snapshot), patch: async () => {} });
  assert.equal(projects.local().some((p) => p.id === project.id), true);
  assert.deepEqual(tabOrigin("tab-retained-origin"), { directory: "/work/retained-source" });
});

test("a project close that waits names each awaited step it started and has not ended", { timeout: 5000 }, async () => {
  let listed = [structuredClone(PROJECT)];
  await projects.initialise({ ...store, snapshot: async () => ({ common: {}, projects: structuredClone(listed), open: [] }),
    remove: async (id) => { listed = listed.filter((item) => item.id !== id); } });
  await projects.activate(PROJECT.id);
  const records = [];
  projects.runSteps(async (step, work) => {
    records.push([step, "start"]);
    try {
      return await work();
    } finally {
      records.push([step, "end"]);
    }
  });
  plane.hold();
  const emptying = emptyStarts();
  const closing = projects.close(PROJECT.id);
  // The held clearing is the step that the close waits for. Once it starts, the records name each step that has not ended.
  await emptying;
  const pending = records.filter(([step, phase]) => phase === "start" && !records.some((item) => item[0] === step && item[1] === "end"))
    .map(([step]) => step);
  assert.deepEqual(pending, ["projects.close.refresh", "projects.read.empty"],
    `the close named no pending step: ${JSON.stringify(records)}`);
  plane.release();
  assert.equal(await closing, true);
  projects.runSteps(null);
});

test("a registry read after the write of this window draws nothing, and a read that finds a change draws once", { timeout: 5000 }, async () => {
  const project = structuredClone(PROJECT);
  const other = { ...structuredClone(PROJECT), id: "prj-other", root: "/work/other", title: "other" };
  const listed = [project, other];
  let open = [];
  let notify = null;
  await projects.initialise({ ...store,
    snapshot: async () => ({ common: {}, projects: structuredClone(listed), open: [...open] }),
    // The host answers a write of this window with workspace-changed, and the snapshot reads the file that the write changed.
    patch: async (id, patch) => { Object.assign(listed.find((item) => item.id === id), patch); notify(); },
    onChange: (fn) => { notify = fn; } });
  await projects.activate(project.id);
  await projects.flush();
  let draws = 0;
  projects.onChange(() => { draws += 1; });
  try {
    const space = projects.addSpace({ state: { cards: [], name: "two" } });
    assert.equal(draws, 1, "the addition draws its space");
    await projects.flush();
    await projects.idle();
    assert.equal(draws, 1, "the read that the write of this window caused drew an unchanged registry");
    assert.ok(projects.active().spaces.some((item) => item.id === space.id));

    other.title = "renamed elsewhere";
    notify();
    await projects.idle();
    assert.equal(draws, 2, "the title that another window changed");
    assert.equal(projects.all().find((item) => item.id === other.id).title, "renamed elsewhere");

    open = [other.id];
    notify();
    await projects.idle();
    assert.equal(draws, 3, "the project that another window opened");
    notify();
    await projects.idle();
    assert.equal(draws, 3, "a read that found the same registry");
  } finally {
    projects.onChange(() => {});
  }
});

test("a change of the store is read through the read of that change", { timeout: 5000 }, async () => {
  let notify = null;
  let snapshots = 0;
  await projects.initialise({
    ...store,
    snapshot: async () => { snapshots += 1; return { common: {}, projects: [structuredClone(PROJECT)], open: [] }; },
    onChange: (fn) => { notify = fn; },
  });
  snapshots = 0;
  let reads = 0;
  notify(async () => {
    reads += 1;
    return { common: {}, projects: [structuredClone(PROJECT)], open: [] };
  });
  await projects.idle();
  assert.equal(reads, 1, "the read of the change");
  assert.equal(snapshots, 0, "no read of its own");
});

test("a registry read that waited behind another read finds what the host holds at its turn", { timeout: 5000 }, async () => {
  const { HostWorkspaceStore } = await import("../host-store.js");
  const listed = [structuredClone(PROJECT)];
  const answer = () => ({ common: {}, projects: structuredClone(listed), open: [] });
  let held = null;
  const listeners = [];
  const host = {
    on: (name, fn) => { listeners.push(fn); },
    call: async () => {
      if (!held) return answer();
      const value = answer();
      const wait = held;
      held = null;
      await wait;
      return value;
    },
  };
  const shared = new HostWorkspaceStore(host);
  await projects.initialise({ ...store, snapshot: () => shared.snapshot(), onChange: (fn) => shared.onChange(fn) });
  // The settings of the window start the read of each change.
  let settings = null;
  shared.onChange((read) => { settings = read(); });
  // The first read holds the registry reads of this window while the read of the second change ends.
  let release = null;
  held = new Promise((resolve) => { release = resolve; });
  listeners[0]();
  listeners[0]();
  await settings;
  // Another window adds a project after that read ended, and its change has not arrived yet.
  listed.push({ ...structuredClone(PROJECT), id: "prj-later", root: "/work/later", title: "later" });
  release();
  await projects.idle();
  assert.ok(projects.all().some((item) => item.id === "prj-later"), "the second registry read reads at its turn");
});

test("the registry and the settings of a window call the host once for one change", { timeout: 5000 }, async () => {
  const { HostWorkspaceStore } = await import("../host-store.js");
  const listeners = [];
  let calls = 0;
  // The answer of the host waits for gate. The read of the initialisation is answered at once.
  let gate = Promise.resolve();
  const host = {
    on: (name, fn) => { listeners.push(fn); },
    call: async () => {
      calls += 1;
      await gate;
      return { common: {}, projects: [structuredClone(PROJECT)], open: [] };
    },
  };
  const shared = new HostWorkspaceStore(host);
  await projects.initialise({ ...store, snapshot: () => shared.snapshot(), onChange: (fn) => shared.onChange(fn) });
  shared.onChange((read) => { read(); });
  calls = 0;
  // The test releases the answer of the host after the page ran every waiting read of the change.
  let answerNow = null;
  gate = new Promise((resolve) => { answerNow = resolve; });
  listeners[0]();
  answerNow();
  await projects.idle();
  assert.equal(calls, 1);
});
