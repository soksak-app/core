// Checks that opening the library and switching a project finish in the order they were received.
// The host calls and the notices of the page are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). The
// modules of the page are the real ones: the project list reads and writes the registry through the workspace calls of the host store,
// the settings, the window operations, the sidecar retention and the page log send their calls to the host. Each test starts the page
// over its own case. The page starts once before the tests, as a window starts: the first start reads the settings, opens the tab state
// files and anchors the clock of the page, so each test starts from the state that this start leaves and passes alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 1,
  activeSpaceId: "spc-one", spaces: [{ id: "spc-one", title: "SPACE1", layout: { state: { cards: [], name: "one" } } }], settings: {},
};

let wire = selectPageWire("projects-switch-import");

// The window of the page: its address, its history and the error event that the page reports failures through.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://soksak.test/index.html" });
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.history = dom.window.history;
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.ErrorEvent = dom.window.ErrorEvent;
// The failures reported through the window error event.
const reported = [];
dom.window.addEventListener("error", (event) => reported.push(event.message));
/** Gives the window the address of the start document with the query. */
const addressWith = (query) => dom.reconfigure({ url: `http://soksak.test/index.html${query}` });

// The project list holds the state of the window (the shown project, the owned projects, the readers of the store). Each test imports its own
// instance of the module, as each start of the page does, so a test starts from the state of a new page and not from the state that an
// earlier test left.
let projects = null;
let instances = 0;
const freshProjects = async () => import(`../projects.js?instance=${++instances}`);
const { registerSection } = await import("../registry.js");
const { installEnvironment } = await import("../environment.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { connectSettings, settingProject } = await import("../settings.js");
const { declareProjectData, viewDataOf } = await import("../plugin-data.js");

// The installed plugin whose tabs are views: a stored tab of a view plugin keeps its origin.
installEnvironment({ runtime: "runtime", workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "retained-probe", title: "probe" }] }] } },
  sidebars: { sets: [], links: [] } }, { plugins: [{ id: "retained-probe", package: "@fixture/retained-probe", version: "0.0.1",
  manifest: { id: "retained-probe", name: "Retained", description: "Retained view.", mark: "r", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/page.html", regions: [], overlays: [] } } } }] });

/**
 * The recorder of the plane. A clear after hold() does not finish until release(). The test rejects a rejected layout.
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
// The surface modules that the plane cleaned up, each with the number of host calls before the cleanup.
const modulesRetained = [];
const attachPlane = (instance) => instance.onSwitch({
  check: (layout) => { if (layout === plane.rejected) throw new Error("fixture layout cannot be opened"); },
  save: (path) => {
    saves.push(path);
    if (plane.layout === null) throw new Error("the plane has no layout to save");
    return plane.layout;
  },
  load: (layout) => { plane.layout = layout; plane.events.push("load"); },
  update: () => {},
  // Cleans up the surface modules outside the tabs of the remaining layout. It also records the order relative to the session cleanup in retained.
  retain: async (surfaceIds) => { modulesRetained.push({ modules: [...surfaceIds], at: wire.calls.length }); },
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
wire.finish();

/**
 * The cleanups in the order they happened since the last forgetRetained: the modules that the plane cleaned up, and the surfaces
 * that the page asked the host to keep as the sessions of the sidecars (the host call sidecarsRetain).
 */
function retained() {
  const entries = modulesRetained.map(({ modules, at }) => ({ key: at - 0.5, value: { modules } }));
  wire.calls.forEach(({ name, payload }, index) => {
    if (name === "sidecarsRetain") entries.push({ key: index, value: payload.surfaces });
  });
  return entries.filter(({ key }) => key >= retainedFrom).sort((a, b) => a.key - b.key).map(({ value }) => value);
}
let retainedFrom = 0;
const forgetRetained = () => { retainedFrom = wire.calls.length; };

/**
 * Prepares the page of a test over its case: a new instance of the project list, the plane without the layout of an earlier test, and the
 * address of the start document without a project.
 */
async function prepare(name) {
  wire = selectPageWire(name);
  modulesRetained.length = 0;
  retainedFrom = 0;
  Object.assign(plane, { layout: null, gate: Promise.resolve(), rejected: null, drawing: false });
  plane.events.length = 0;
  saves.length = 0;
  clearStarted = null;
  reported.length = 0;
  addressWith("");
  projects = await freshProjects();
  attachPlane(projects);
}

/** Starts the page over the case of a test: the settings and the project list connect to the host store. */
async function start(name, { initialise = true } = {}) {
  await prepare(name);
  const store = new HostWorkspaceStore(host);
  await connectSettings(store);
  if (initialise) await projects.initialise(store);
  return store;
}

// The first start of the page, with an empty registry.
await start("projects-switch-prelude");
wire.finish();

/** The workspace calls of the page of the kind. */
const workspaceCalls = (kind) => wire.calls.filter(({ name, payload }) => name === "workspace" && payload.kind === kind);
/** The names of the host calls of the page from the call at index from on. */
const namesFrom = (from) => wire.calls.slice(from).map(({ name }) => name);

test("opening a project while the library is still clearing the plane loads it after the clearing", { timeout: 5000 }, async () => {
  await start("projects-switch-clearing");
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
  wire.finish();
});

test("plugin states follow the shown project and project data is patched under plugins", async () => {
  await start("projects-switch-project-data");
  declareProjectData("probe", { marks: { schema: { type: "array" }, default: [] } });
  await projects.browse();
  await projects.activate(PROJECT.id);
  await projects.browse();
  await projects.activate(PROJECT.id);
  const data = viewDataOf({ id: PROJECT.id }, "probe");
  assert.deepEqual(data.get("marks"), []);
  await data.set("marks", ["a"]);
  const patch = workspaceCalls("patch").at(-1).payload;
  assert.deepEqual([patch.id, patch.patch], [PROJECT.id, { plugins: { probe: { marks: { format: 1, value: ["a"] } } } }]);
  assert.deepEqual(data.get("marks"), ["a"]);
  await projects.flush();
  wire.finish();
});

test("a flush writes the window geometry only when it changed", async () => {
  await start("projects-switch-geometry");
  await projects.browse();
  await projects.activate(PROJECT.id);
  const geometryPatches = () => workspaceCalls("patch").filter(({ payload }) => payload.patch.geometry).map(({ payload }) => payload.patch.geometry);
  await projects.flush();
  await projects.flush();
  assert.deepEqual(geometryPatches(), [{ x: 1, y: 2, width: 300, height: 200 }], "an unchanged geometry was written again");
  await projects.flush();
  assert.equal(geometryPatches().length, 2, "a changed geometry was not written");
  wire.finish();
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
  const store = await start("projects-switch-layout-surfaces", { initialise: false });
  await projects.initialise(store);
  assert.deepEqual(projects.layoutSurfaces(), [
    { surface: "tab-one", plugin: "beta", root: "/work/one" },
    { surface: "tab-a", plugin: "fixture", root: "/work/two" },
    { surface: "tab-b", plugin: "fixture", root: "/work/two" },
  ]);
  forgetRetained();
  modulesRetained.length = 0;
  await projects.close("prj-two");
  // It cleans up the surface modules of the deleted project first. If a module remains, it reopens the finished session in the deleted folder (F44).
  assert.deepEqual(retained(), [{ modules: ["tab-one"] }, [{ surface: "tab-one", plugin: "beta", root: "/work/one" }]],
    "removing a project disposes the surface modules of its tabs before it ends their sidecar sessions");
  reported.length = 0;
  await projects.initialise(store);
  assert.deepEqual(reported, ["project prj-three space spc-one has no layout cards"],
    "the reconciliation of the tab state store reports a layout without cards and keeps the entries");
  reported.length = 0;
  assert.throws(() => projects.layoutSurfaces(), /has no layout cards/, "a layout without cards is an explicit error");
  wire.finish();
});

test("the layouts hold the sections of every space of every project, whatever the window draws, with the sets of each project", async () => {
  // Each section names the plugin that declares it, and a section that no loaded plugin declares (gone.list) has no surface.
  for (const [id, plugin] of [["alpha.tree", "alpha"], ["alpha.bookmarks", "alpha"], ["other.list", "other"]]) {
    registerSection({ id, name: id, plugin, surface: { composition: { kind: "view" } } });
  }
  await start("projects-switch-sections");
  assert.deepEqual(projects.layoutSurfaces(), [
    { surface: "tab-x", plugin: "beta", root: "/work/a" },
    { surface: "spc-a1/left/alpha.tree", plugin: "alpha", root: "/work/a" },
    { surface: "spc-a1/crd:left/alpha.bookmarks", plugin: "alpha", root: "/work/a" },
    { surface: "spc-a2/left/alpha.tree", plugin: "alpha", root: "/work/a" },
    { surface: "spc-b/right/other.list", plugin: "other", root: "/work/b" },
  ]);
  wire.finish();
});

/** The ids of the projects that the page asked the host to open from the call at index from on. */
const openedFrom = (from) => wire.calls.slice(from).filter(({ name }) => name === "projectOpen").map(({ payload }) => payload.id);

test("a saved layout that fails the plane check rejects the open before any project or window change", async () => {
  await start("projects-switch-plane-check");
  await projects.activate(PROJECT.id);
  const shown = plane.layout;
  plane.rejected = projects.all().find((item) => item.id === "prj-bad").spaces[0].layout;
  const from = wire.calls.length;
  plane.events.length = 0;
  await assert.rejects(projects.activate("prj-bad"), /fixture layout cannot be opened/);
  assert.equal(projects.active().id, PROJECT.id, "the rejected open replaced the active project");
  assert.deepEqual(openedFrom(from), [], "the rejected open asked the host for a window");
  assert.deepEqual(wire.calls.slice(from).filter(({ name, payload }) => name === "workspace" && payload.kind === "patch" && payload.id === "prj-bad"), [],
    "the rejected open changed the saved record");
  assert.deepEqual(plane.events, [], "the rejected open replaced the plane");
  assert.equal(plane.layout, shown);
  await projects.flush();
  // This caller, which received the rejection, reports the rejected open. The switch sequence does not report the same failure again as a window error (G1.4-113).
  assert.deepEqual(reported, [], "the rejected open was reported again as a window error");
  plane.rejected = null;
  await projects.flush();
  wire.finish();
});

test("opening a project whose folder cannot be read rejects with the host's message", async () => {
  await start("projects-switch-folder-unreadable");
  const from = wire.calls.length;
  reported.length = 0;
  await assert.rejects(projects.activate("prj-missing"),
    { message: "project directory does not exist: /work/missing" });
  assert.deepEqual(openedFrom(from), [], "the failed open asked the host for a window");
  // The caller that received the rejection reports the failure once. The switch sequence does not report the same failure again as a window error (G1.4-113).
  await projects.flush();
  assert.deepEqual(reported, [], "the failed switch was reported again as a window error");
  wire.finish();
});

test("switching to or closing into a space that fails the plane check changes neither the active space nor the plane", async () => {
  // The project that this window owns keeps its space in memory, so the test uses a different project from the earlier tests.
  await start("projects-switch-space-check");
  await projects.activate("prj-spaces");
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
  wire.finish();
});

test("the start document draws the window's project before the store connects and the activation resumes it", async () => {
  await prepare("projects-switch-start-document");
  const project = { ...structuredClone(PROJECT), id: "prj-begin", root: "/work/begin" };
  const snapshot = { common: {}, projects: [structuredClone(project)], open: [] };
  addressWith(`?project=${project.id}`);
  plane.events.length = 0;
  projects.begin(structuredClone(snapshot));
  assert.equal(projects.active().id, project.id);
  assert.equal(projects.inLibrary(), false);
  assert.deepEqual(plane.events, ["load"], "the first screen did not draw the project's space");
  assert.equal(settingProject(), project.id, "the first screen did not apply the project's settings");
  const from = wire.calls.length;
  const store = new HostWorkspaceStore(host);
  await connectSettings(store);
  await projects.initialise(store);
  assert.deepEqual(openedFrom(from), [project.id], "the activation did not open the project's window");
  assert.deepEqual(workspaceCalls("patch").map(({ payload }) => [payload.id, Object.keys(payload.patch)]), [[project.id, ["lastOpened"]]],
    "the activation saved more than the open time");
  assert.equal(projects.active().id, project.id);
  await projects.flush();
  wire.finish();
});

test("the start document draws the project synchronously while the host theme reply is pending", { timeout: 5000 }, async () => {
  await prepare("projects-switch-theme-pending");
  const project = { ...structuredClone(PROJECT), id: "prj-theme-start", root: "/work/theme-start" };
  const snapshot = { common: {}, projects: [structuredClone(project)], open: [] };
  addressWith(`?project=${project.id}`);
  plane.events.length = 0;

  projects.begin(structuredClone(snapshot));
  assert.deepEqual(plane.events, ["load"], "the first DOM layout waited for the host theme reply");
  await drained();
  wire.release();
  await drained();
  wire.finish();
});

test("a project whose settings file the host refused is not opened, and the start shows the library with the error", async () => {
  await prepare("projects-switch-settings-refused");
  const error = "/work/refused/.soksak/settings.json: settings.json: format must be 1";
  const refused = { ...structuredClone(PROJECT), id: "prj-refused", root: "/work/refused", settingsError: error };
  delete refused.settings;
  const snapshot = { common: {}, projects: [structuredClone(PROJECT), structuredClone(refused)], open: [] };
  addressWith(`?project=${refused.id}`);
  plane.events.length = 0;
  reported.length = 0;
  projects.begin(structuredClone(snapshot));
  assert.equal(projects.active(), null, "the first screen drew the project whose settings file was refused");
  assert.equal(settingProject(), null, "the settings began with the project whose settings file was refused");
  const from = wire.calls.length;
  const store = new HostWorkspaceStore(host);
  await connectSettings(store);
  await projects.initialise(store);
  assert.equal(projects.active(), null);
  assert.equal(projects.inLibrary(), true);
  assert.deepEqual(openedFrom(from), [], "the refused project asked the host for a window");
  assert.deepEqual(reported, [error], "the start did not report the refused settings file once");
  await assert.rejects(projects.activate(refused.id), { message: error });
  assert.deepEqual(openedFrom(from), [], "the refused open asked the host for a window");
  // The other project opens.
  await projects.activate(PROJECT.id);
  assert.equal(projects.active().id, PROJECT.id);
  await projects.flush();
  wire.finish();
});

test("a project that the start document drew falls back to the library when its activation fails", async () => {
  await prepare("projects-switch-start-fallback");
  const missing = { ...structuredClone(PROJECT), id: "prj-gone", root: "/work/missing" };
  const snapshot = { common: {}, projects: [structuredClone(missing)], open: [] };
  addressWith(`?project=${missing.id}`);
  projects.begin(structuredClone(snapshot));
  assert.equal(projects.active().id, missing.id);
  plane.events.length = 0;
  reported.length = 0;
  const store = new HostWorkspaceStore(host);
  await connectSettings(store);
  await projects.initialise(store);
  assert.equal(projects.active(), null);
  assert.equal(projects.inLibrary(), true);
  assert.deepEqual(plane.events, ["empty started", "emptied"]);
  assert.equal(globalThis.location.search, "");
  assert.deepEqual(reported, ["project directory does not exist: /work/missing"], "the failed start activation was not reported once");
  wire.finish();
});

test("a project removed from the registry by another window ends in the window that shows it as closing its tab does", { timeout: 5000 }, async () => {
  await start("projects-switch-removed-elsewhere");
  reported.length = 0;
  // This window shows two projects as tabs, and prj-shown is active. prj-other is the project of another window.
  await projects.activate("prj-next");
  await projects.activate("prj-shown");
  // Another window deletes prj-shown, and the host notifies this window of the change. projects.idle resolves when the handling of the notification has finished.
  const removeElsewhere = async () => {
    forgetRetained();
    modulesRetained.length = 0;
    plane.events.length = 0;
    wire.deliverNotice();
    await projects.idle();
  };
  const patchesBefore = workspaceCalls("patch").length;
  await removeElsewhere();
  assert.equal(projects.all().some((item) => item.id === "prj-shown"), false);
  assert.equal(projects.active()?.id, "prj-next", "the window did not open its next project as closing the project tab does");
  assert.deepEqual(retained().slice(0, 2), [
    { modules: ["tab-next", "tab-other"] },
    [{ surface: "tab-next", plugin: "fixture", root: "/work/prj-next" }, { surface: "tab-other", plugin: "fixture", root: "/work/prj-other" }],
  ], "the window kept the surface modules and sidecar sessions of the removed project's tabs");
  assert.equal(workspaceCalls("patch").slice(patchesBefore).some(({ payload }) => payload.id === "prj-shown"), false, "the window saved the removed project");
  await removeElsewhere();
  assert.equal(projects.active(), null);
  assert.equal(projects.inLibrary(), true, "the window without a project did not show the library");
  assert.deepEqual(projects.local(), []);
  assert.deepEqual(retained(), [{ modules: ["tab-other"] }, [{ surface: "tab-other", plugin: "fixture", root: "/work/prj-other" }]],
    "the window kept the surface modules and sidecar sessions of its last removed project");
  assert.deepEqual(reported, [], "ending the removed project reported an error");
  await projects.flush();
  wire.finish();
});

test("an activation received while a removed project is clearing waits for the clear", { timeout: 5000 }, async () => {
  await start("projects-switch-clearing-removed");
  await projects.activate("prj-clearing-removed");

  plane.events.length = 0;
  plane.hold();
  const emptying = emptyStarts();
  wire.deliverNotice();
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
    const activation = projects.activate("prj-clearing-next");
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
  assert.equal(projects.active()?.id, "prj-clearing-next");
  assert.equal(projects.inLibrary(), false);
  await projects.flush();
  wire.finish();
});

// WebKit runs the reaction of a promise that the host reply fulfilled at the next microtask checkpoint, and that checkpoint can come after the ResizeObserver callback of the next
// rendering update. If the switch to the library happens in that reaction, elements of the work area that the observation round
// already delivered (the file tree, the terminal screen) become 0x0 and a loop error occurs (F43). The switch must happen in the drawing that clears the plane,
// that is, in the next task, which runs outside the observation round.
test("browsing shows the library in the draw that empties the plane, not where a later host reply resolves", { timeout: 5000 }, async () => {
  await start("projects-switch-browse-draw");
  await projects.activate(PROJECT.id);
  let screen = "workspace";
  let inRound = false;
  const switches = [];
  projects.onChange(() => {
    const next = projects.inLibrary() ? "library" : "workspace";
    if (next !== screen) switches.push(`${next} in ${plane.drawing ? "the empty draw" : inRound ? "the observation round" : "a task"}`);
    screen = next;
  });
  try {
    // The host reply of the settings project selection is held and fulfilled at the checkpoint after the callback of the file tree observer.
    const browsing = projects.browse();
    await drained();
    // Observation round: the tree callback runs, and the held reply is fulfilled at that checkpoint.
    inRound = true;
    wire.release();
    await browsing;
    inRound = false;
    assert.deepEqual(switches, ["library in the empty draw"], "the library screen was not drawn by the draw that empties the plane");
  } finally {
    projects.onChange(() => {});
  }
  await projects.flush();
  // The window still owns the project after browsing, and an owned project keeps its in-memory layout over the next
  // snapshot; removing the project ends that ownership, so a later check reads the layout of its own snapshot.
  assert.equal(await projects.close(PROJECT.id), true, "the project that the check opened was not removed");
  assert.equal(projects.local().length, 0, "the window still owns a project after the check");
  wire.finish();
});

test("closing a tab removes its session file after the layout write, and the start removes the files of tabs in no layout", async () => {
  const layout = (...tabs) => ({ state: { cards: [{ id: "card-one", data: { tabs: tabs.map((id) => ({ id, plugin: "fixture" })) } }] } });
  plane.layout = layout("tab-a", "tab-b");
  await start("projects-switch-session-files");
  const puts = () => workspaceCalls("tabSessionPut").map(({ payload }) => [payload.tab, payload.regions]);
  assert.deepEqual(puts(), [["tab-gone", null]], "the start kept the session file of a tab in no layout");
  await projects.activate("prj-one");
  const putsBefore = puts().length;
  forgetRetained();
  modulesRetained.length = 0;
  plane.layout = layout("tab-b");
  await projects.keep();
  assert.deepEqual(puts().slice(putsBefore), [["tab-a", null]], "closing a tab left its session file");
  assert.deepEqual(retained().filter(Array.isArray), [[{ surface: "tab-b", plugin: "fixture", root: "/work/one" }]],
    "closing the last layout occurrence did not retain only the remaining project surfaces");
  await projects.flush();

  reported.length = 0;
  plane.layout = layout("tab-c");
  await assert.rejects(projects.keep(), /sidecars are stopped/,
    "a rejected retain operation was reported as a successful layout save");
  assert.deepEqual(reported, ["sidecars are stopped"], "the retain failure was not reported exactly once");
  await projects.flush();
  wire.finish();
});

test("a refused layout write answers its caller, and the next layout write and the same layout reach the store", async () => {
  plane.layout = PROJECT.spaces[0].layout;
  await start("projects-switch-refused-write");
  await projects.activate(PROJECT.id);
  const written = () => workspaceCalls("patch").filter(({ payload }) => payload.patch.spaces).map(({ payload }) => payload.patch.spaces[0].layout.state.name);
  const named = (name) => ({ state: { ...PROJECT.spaces[0].layout.state, name } });
  const before = written().length;
  plane.layout = named("refused");
  await assert.rejects(projects.keep(), /no space left on device/);
  await projects.keep();
  assert.deepEqual(written().slice(before), ["refused", "refused"], "the refused layout was not written again");
  plane.layout = named("later");
  await projects.keep();
  assert.deepEqual(written().slice(before), ["refused", "refused", "later"], "a write after a refused write did not reach the store");
  assert.equal(await projects.close(PROJECT.id), true);
  wire.finish();
});

test("each layout save names its writing path: add space for a new space of the shown project", async () => {
  await start("projects-switch-save-path");
  saves.length = 0;
  await projects.activate(PROJECT.id);
  projects.addSpace(PROJECT.spaces[0].layout);
  assert.equal(saves.at(-1), "add space");
  assert.ok(saves.every((path) => typeof path === "string"), "a save names its writing path");
  await projects.flush();
  wire.finish();
});

test("a reopened project restores inactive-space origins before retained views can start", { timeout: 5000 }, async () => {
  await prepare("projects-switch-retained-origin");
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
  addressWith(`?project=${project.id}`);
  projects.begin(structuredClone(snapshot));
  const store = new HostWorkspaceStore(host);
  await connectSettings(store);
  await projects.initialise(store);
  assert.equal(projects.local().some((p) => p.id === project.id), true);
  assert.deepEqual(tabOrigin("tab-retained-origin"), { directory: "/work/retained-source" });
  wire.finish();
});

test("a project close that waits names each awaited step it started and has not ended", { timeout: 5000 }, async () => {
  await start("projects-switch-close-steps");
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
  wire.finish();
});

test("a registry read after the write of this window draws nothing, and a read that finds a change draws once", { timeout: 5000 }, async () => {
  await start("projects-switch-registry-draws");
  await projects.activate(PROJECT.id);
  await projects.flush();
  // The host answers each write with workspace-changed, and the window reads the registry for each of them.
  for (const written of workspaceCalls("patch")) {
    wire.deliverNotice();
    await projects.idle();
  }
  let draws = 0;
  projects.onChange(() => { draws += 1; });
  try {
    const space = projects.addSpace({ state: { cards: [], name: "two" } });
    assert.equal(draws, 1, "the addition draws its space");
    await projects.flush();
    // The host answers a write of this window with workspace-changed, and the snapshot reads the file that the write changed.
    wire.deliverNotice();
    await projects.idle();
    assert.equal(draws, 1, "the read that the write of this window caused drew an unchanged registry");
    assert.ok(projects.active().spaces.some((item) => item.id === space.id));

    // Another window renames the project prj-other.
    wire.deliverNotice();
    await projects.idle();
    assert.equal(draws, 2, "the title that another window changed");
    assert.equal(projects.all().find((item) => item.id === "prj-other").title, "renamed elsewhere");

    // Another window opens the project prj-other.
    wire.deliverNotice();
    await projects.idle();
    assert.equal(draws, 3, "the project that another window opened");
    wire.deliverNotice();
    await projects.idle();
    assert.equal(draws, 3, "a read that found the same registry");
  } finally {
    projects.onChange(() => {});
  }
  wire.finish();
});

test("a change of the store is read through the read of that change", { timeout: 5000 }, async () => {
  await start("projects-switch-change-read");
  const snapshots = () => workspaceCalls("snapshot").length;
  const before = snapshots();
  // The host answers the read of the change after both readers of the window started it: the registry takes the answer of that read.
  wire.deliverNotice();
  await drained();
  wire.release();
  await projects.idle();
  assert.equal(snapshots() - before, 1, "the read of the change is the only registry read");
  assert.equal(projects.all()[0].title, "renamed by the change", "the registry did not take the answer of the read of the change");
  wire.finish();
});

test("a registry read that waited behind another read finds what the host holds at its turn", { timeout: 5000 }, async () => {
  await prepare("projects-switch-read-turn");
  const { HostWorkspaceStore } = await import("../host-store.js");
  const shared = new HostWorkspaceStore(host);
  await projects.initialise(shared);
  await connectSettings(shared);
  // The settings of the window start the read of each change.
  let settings = null;
  shared.onChange((read) => { settings = read(); });
  // The first read holds the registry reads of this window while the read of the second change ends.
  wire.deliverNotice();
  wire.deliverNotice();
  await settings;
  // Another window adds a project after that read ended, and its change has not arrived yet.
  wire.release();
  await projects.idle();
  assert.ok(projects.all().some((item) => item.id === "prj-later"), "the second registry read reads at its turn");
  wire.finish();
});

test("the registry and the settings of a window call the host once for one change", { timeout: 5000 }, async () => {
  await start("projects-switch-one-call");
  const snapshots = () => workspaceCalls("snapshot").length;
  // The answer of the host waits until the test releases it, after the page ran every waiting read of the change.
  const before = snapshots();
  wire.deliverNotice();
  await drained();
  wire.release();
  await projects.idle();
  assert.equal(snapshots() - before, 1);
  wire.finish();
});
