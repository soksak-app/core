// Checks that opening the library and switching a project finish in the order they were received.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 1,
  activeSpaceId: "spc-one", spaces: [{ id: "spc-one", title: "SPACE1", layout: { state: { cards: [], name: "one" } } }], settings: {},
};

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
// Records the calls that clean up sidecar sessions.
// The page event queue drains before a window closes; the queue of this test holds no events.
mock.module("../page-log.js", {
  namedExports: { flushEvents: async () => {}, emitEvent: () => {} },
});
const retained = [];
mock.module("../host.js", {
  namedExports: {
    log: () => {},
    retainSidecarSessions: async (surfaces) => { retained.push(surfaces); return { closed: 0 }; },
    windowSidecar: () => null,
    documents: null,
    report: () => {},
  },
});
/* The order in which the project that the window showed was reported to the state module. */
const shownStates = [];
let stateOptions = null;
mock.module("../plugin-states.js", {
  namedExports: {
    configureStates: (values) => { stateOptions = values; },
    showStates: async (project) => { shownStates.push(project?.id ?? null); },
  },
});
/* The project that the first screen chose for the settings. */
const begunSettings = [];
/* The host reply of the settings project selection. The test can hold the reply. */
let selection = async () => {};
mock.module("../settings.js", {
  namedExports: {
    beginSettings: (snapshot, id) => { begunSettings.push(id); },
    selectProject: () => selection(),
    value: () => "tabs",
    flushSettings: async () => {},
  },
});

// The document global that the project module uses. It records the failures reported through the window error event.
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
globalThis.location = new URL("http://soksak.test/index.html");
globalThis.history = { replaceState: (state, title, url) => { globalThis.location = new URL(url, globalThis.location); } };

const projects = await import("../projects.js");

/**
 * A recorder that acts as the plane. A clear after hold() does not finish until release(). The test rejects a rejected layout.
 * The drawing of a clear erases the plane and runs the screen drawing it received (show). drawing is true during that drawing.
 */
const plane = { layout: null, events: [], gate: Promise.resolve(), rejected: null, drawing: false };
plane.hold = () => {
  plane.gate = new Promise((resolve) => { plane.release = resolve; });
};
projects.onSwitch({
  check: (layout) => { if (layout === plane.rejected) throw new Error("fixture layout cannot be opened"); },
  save: () => {
    if (plane.layout === null) throw new Error("the plane has no layout to save");
    return plane.layout;
  },
  load: (layout) => { plane.layout = layout; plane.events.push("load"); },
  update: () => {},
  // Cleans up the surface modules outside the tabs of the remaining layout. It also records the order relative to the session cleanup in retained.
  retain: async (surfaceIds) => { retained.push({ modules: [...surfaceIds] }); },
  presented: async () => {},
  empty: async (show) => {
    plane.events.push("empty started");
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

test("opening a project while the library is still clearing the plane loads it after the clearing", async () => {
  await projects.initialise(store);
  await projects.activate(PROJECT.id);
  assert.deepEqual(plane.layout, PROJECT.spaces[0].layout);

  plane.events.length = 0;
  plane.hold();
  const browsing = projects.browse();
  const opening = projects.activate(PROJECT.id);
  // The fake store and the fake runtime all finish within microtasks. After waiting for the next macrotask,
  // all work that the clear did not block has finished.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plane.events, ["empty started"], "the project was loaded while the plane was being cleared");
  plane.release();
  await Promise.all([browsing, opening]);
  assert.deepEqual(plane.events, ["empty started", "emptied", "load"]);
  assert.deepEqual(plane.layout, PROJECT.spaces[0].layout);
  await projects.flush();
});

test("plugin states follow the shown project and project data is patched under plugins", async () => {
  const patches = [];
  await projects.initialise({ ...store, patch: async (id, patch) => { patches.push([id, patch]); } });
  await projects.browse();
  shownStates.length = 0;
  await projects.activate(PROJECT.id);
  await projects.browse();
  await projects.activate(PROJECT.id);
  assert.deepEqual(shownStates, [PROJECT.id, null, PROJECT.id]);
  assert.deepEqual(stateOptions.data.get(PROJECT.id, "probe"), {});
  await stateOptions.data.set(PROJECT.id, "probe", "marks", ["a"]);
  assert.deepEqual(patches.at(-1), [PROJECT.id, { plugins: { probe: { marks: ["a"] } } }]);
  assert.deepEqual(stateOptions.data.get(PROJECT.id, "probe"), { marks: ["a"] });
  await projects.flush();
});

test("the surfaces of every layout are listed with their project root, and removing a project retains the rest", async () => {
  const layout = { state: { cards: [
    { id: "left" },
    { id: "right", data: { tabs: [{ id: "tab-a" }, { id: "tab-b" }] } },
  ] } };
  const two = {
    ...structuredClone(PROJECT), id: "prj-two", root: "/work/two",
    spaces: [{ id: "spc-two", title: "SPACE1", layout }],
  };
  const one = { ...structuredClone(PROJECT), id: "prj-three" };
  one.spaces[0].layout = { state: { cards: [{ id: "one", data: { tabs: [{ id: "tab-one" }] } }] } };
  let listed = [one, two];
  const local = { ...store, snapshot: async () => ({ common: {}, projects: listed.map((item) => structuredClone(item)), open: [] }),
    remove: async (id) => { listed = listed.filter((item) => item.id !== id); } };
  await projects.initialise(local);
  assert.deepEqual(projects.layoutSurfaces(), [
    { surface: "tab-one", root: "/work/one" },
    { surface: "tab-a", root: "/work/two" },
    { surface: "tab-b", root: "/work/two" },
  ]);
  retained.length = 0;
  await projects.close("prj-two");
  // It cleans up the surface modules of the deleted project first. If a module remains, it reopens the finished session in the deleted folder (F44).
  assert.deepEqual(retained, [{ modules: ["tab-one"] }, [{ surface: "tab-one", root: "/work/one" }]],
    "removing a project disposes the surface modules of its tabs before it ends their sidecar sessions");
  listed[0].spaces[0].layout = { state: {} };
  reported.length = 0;
  await projects.initialise(local);
  assert.deepEqual(reported, ["project prj-three space spc-one has no layout cards"],
    "the reconciliation of the tab state store reports a layout without cards and keeps the entries");
  reported.length = 0;
  assert.throws(() => projects.layoutSurfaces(), /has no layout cards/, "a layout without cards is an explicit error");
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
  shownStates.length = 0;
  await projects.initialise({ ...store, snapshot: async () => structuredClone(snapshot), patch: async (id, patch) => { patches.push([id, Object.keys(patch)]); } });
  windows.state = state;
  assert.deepEqual(openRequests, [project.id], "the activation did not open the project's window");
  assert.deepEqual(shownStates, [project.id]);
  assert.deepEqual(patches, [[project.id, ["lastOpened"]]], "the activation saved more than the open time");
  assert.equal(projects.active().id, project.id);
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

test("a project removed from the registry by another window ends in the window that shows it as closing its tab does", async () => {
  /** A project with one tab in one card. */
  const project = (id, tab) => ({ ...structuredClone(PROJECT), id, root: `/work/${id}`, spaces: [
    { id: `spc-${id}`, title: "SPACE1", layout: { state: { cards: [{ id: `card-${id}`, data: { tabs: [{ id: tab }] } }] } } },
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
  // Another window deletes prj-shown, and the store notifies this window of the change. The fake store and the fake runtime finish within microtasks, so
  // after waiting for the next macrotask, the handling of the notification has finished.
  const removeElsewhere = async (id) => {
    listed = listed.filter((item) => item.id !== id);
    retained.length = 0;
    patches.length = 0;
    plane.events.length = 0;
    notify();
    await new Promise((resolve) => setImmediate(resolve));
  };
  await removeElsewhere("prj-shown");
  assert.equal(projects.all().some((item) => item.id === "prj-shown"), false);
  assert.equal(projects.active()?.id, "prj-next", "the window did not open its next project as closing the project tab does");
  assert.deepEqual(retained.slice(0, 2), [
    { modules: ["tab-next", "tab-other"] },
    [{ surface: "tab-next", root: "/work/prj-next" }, { surface: "tab-other", root: "/work/prj-other" }],
  ], "the window kept the surface modules and sidecar sessions of the removed project's tabs");
  assert.equal(patches.includes("prj-shown"), false, "the window saved the removed project");
  await removeElsewhere("prj-next");
  assert.equal(projects.active(), null);
  assert.equal(projects.inLibrary(), true, "the window without a project did not show the library");
  assert.deepEqual(projects.local(), []);
  assert.deepEqual(retained, [{ modules: ["tab-other"] }, [{ surface: "tab-other", root: "/work/prj-other" }]],
    "the window kept the surface modules and sidecar sessions of its last removed project");
  assert.deepEqual(reported, [], "ending the removed project reported an error");
  await projects.flush();
});

// WebKit runs the reaction of a promise that the host reply fulfilled at the next microtask checkpoint, and that checkpoint can come after the ResizeObserver callback of the next
// rendering update. If the switch to the library happens in that reaction, elements of the work area that the observation round
// already delivered (the file tree, the terminal screen) become 0x0 and a loop error occurs (F43). The switch must happen in the drawing that clears the plane,
// that is, in the next task, which runs outside the observation round.
test("browsing shows the library in the draw that empties the plane, not where a later host reply resolves", async () => {
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
  selection = () => reply.promise;
  try {
    const browsing = projects.browse();
    await new Promise((resolve) => setImmediate(resolve));
    // Observation round: the tree callback runs, and the held reply is fulfilled at that checkpoint.
    inRound = true;
    reply.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    inRound = false;
    await browsing;
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
  const layout = (...tabs) => ({ state: { cards: [{ id: "card-one", data: { tabs: tabs.map((id) => ({ id })) } }] } });
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
  plane.layout = layout("tab-b");
  await projects.keep();
  assert.deepEqual(puts, [["tab-a", null]], "closing a tab left its session file");
  await projects.flush();
});
