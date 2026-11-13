// Checks the project switch against the native project-open and project-shown notifications.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const layout = { state: { cards: [] } };
const projectsSnapshot = [
  { id: "prj-alpha", root: "/work/alpha", identity: "alpha", title: "alpha", color: "#fff", named: 1,
    activeSpaceId: "spc-alpha", spaces: [{ id: "spc-alpha", title: "SPACE1", layout }],
    plugins: { probe: { label: { format: 1, value: "alpha data" } } }, settings: {} },
  { id: "prj-beta", root: "/work/beta", identity: "beta", title: "beta", color: "#fff", named: 1,
    activeSpaceId: "spc-beta", spaces: [{ id: "spc-beta", title: "SPACE1", layout }],
    plugins: { probe: { label: { format: 1, value: "beta data" } } }, settings: {} },
];

const hostCalls = [];
const released = [];
let failOpen = false;
let failShown = false;
let failTabStateOpen = false;
let failTabStateOpenWithUndefined = false;
let failSelection = null;
let selectedProject = null;
let openLocal = true;
let activateTarget = null;
let nativeShown = null;
let contextPendingAtLibraryEmpty = false;
mock.module("@soksak/runtime", {
  namedExports: {
    windows: {
      folder: async (root) => ({ root, identity: root === "/work/alpha" ? "alpha" : "beta" }),
      openProject: async ({ id }) => {
        if (failOpen) throw new Error("native project open failed");
        return { local: openLocal, staged: openLocal && nativeShown?.id !== id };
      },
      projectShown: async (project) => {
        if (failShown) throw new Error("native project publication failed");
        nativeShown = project;
        hostCalls.push({ id: project?.id ?? null, source: "project shown notification" });
      },
      ready: async () => {},
      releaseProject: async (id) => { released.push(id); },
      state: async () => null,
      close: async () => {},
      onRemoveProjectRequest: async () => {},
      askRemoveProject: async () => true,
      answerRemoveProject: async () => {},
      onActivate: async (fn) => { activateTarget = fn; },
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
  namedExports: { projectSidebars: () => ({ sets: [], links: [] }), beginSettings: (_snapshot, id) => { selectedProject = id; }, selectProject: async (id) => {
    selectedProject = id;
    if (id === failSelection) throw new Error("settings project selection failed");
  }, value: () => "tabs", flushSettings: async () => {} },
});
mock.module("../tab-state.js", {
  namedExports: { openTabStates: async () => {
    if (failTabStateOpenWithUndefined) throw undefined;
    if (failTabStateOpen) throw new Error("tab-state store open failed");
    return { reconcile: async () => {}, flush: async () => {} };
  } },
});
mock.module("../tab-session.js", {
  namedExports: { createTabSessions: () => ({ read: () => null, reconcile: async () => {}, flush: async () => {} }) },
});

globalThis.dispatchEvent = () => true;
globalThis.location = new URL("http://soksak.test/index.html?project=prj-alpha");
globalThis.history = { replaceState: (state, title, url) => { globalThis.location = new URL(url, globalThis.location); } };

mock.module("../environment.js", { namedExports: { pluginUnits: () => [] } });

const projects = await import("../projects.js");

const plane = { layout: null };
let loadsBeforeInitialContextCommit = 0;
projects.onSwitch({
  check: () => {},
  save: () => plane.layout ?? layout,
  load: (next) => {
    plane.layout = next;
    if (!projects.initialProjectContextReady()) loadsBeforeInitialContextCommit++;
  },
  update: () => {},
  retain: async () => {},
  presented: async () => {},
  empty: async (show) => {
    contextPendingAtLibraryEmpty = !projects.initialProjectContextReady();
    plane.layout = null;
    show?.();
  },
});

const store = {
  snapshot: async () => ({ common: {}, projects: structuredClone(projectsSnapshot), open: [] }),
  tabState: async () => null,
  tabStatePut: async () => 0,
  tabSession: async () => null,
  tabSessionPut: async () => null,
  tabSessions: async () => [],
  patch: async () => {},
  add: async () => {},
  remove: async () => {},
  onChange: () => {},
};

test("a page start without a project does not wait for project context", async () => {
  const previousLocation = globalThis.location;
  try {
    globalThis.location = new URL("http://soksak.test/index.html");
    projects.begin({ common: {}, projects: structuredClone(projectsSnapshot), open: [] });
    assert.equal(projects.initialProjectContextReady(), true);
    await projects.waitForInitialProjectContext();
  } finally {
    globalThis.location = previousLocation;
  }
});

test("a failed first activation releases startup waiters after the preview is cleared", async () => {
  globalThis.location = new URL("http://soksak.test/index.html?project=prj-alpha");
  failSelection = "never";
  failShown = true;
  projects.begin({ common: {}, projects: structuredClone(projectsSnapshot), open: [] });
  const initialContext = projects.waitForInitialProjectContext();
  await projects.initialise(store);
  await initialContext;
  failShown = false;
  failSelection = null;

  assert.equal(contextPendingAtLibraryEmpty, true,
    "the initial context gate opened before leaveBegun cleared the preview layout");
  assert.equal(projects.initialProjectContextReady(), true);
  assert.equal(projects.active(), null, "a rejected first activation left the preview project active");
});

test("a failed initialisation rejects the startup context without marking it ready", async () => {
  globalThis.location = new URL("http://soksak.test/index.html?project=prj-alpha");
  projects.begin({ common: {}, projects: structuredClone(projectsSnapshot), open: [] });
  const initialContext = projects.waitForInitialProjectContext();
  failTabStateOpen = true;
  await assert.rejects(projects.initialise(store), /tab-state store open failed/);
  failTabStateOpen = false;
  await assert.rejects(initialContext, /tab-state store open failed/);
  assert.equal(projects.initialProjectContextReady(), false,
    "a rejected startup context was exposed as ready to later view and background-session work");
});

test("an initialisation rejected with undefined does not resolve the startup context", async () => {
  globalThis.location = new URL("http://soksak.test/index.html?project=prj-alpha");
  projects.begin({ common: {}, projects: structuredClone(projectsSnapshot), open: [] });
  const initialContext = projects.waitForInitialProjectContext();
  failTabStateOpenWithUndefined = true;
  await assert.rejects(projects.initialise(store), (reason) => reason === undefined);
  failTabStateOpenWithUndefined = false;
  await assert.rejects(initialContext, (reason) => reason === undefined);
  assert.equal(projects.initialProjectContextReady(), false,
    "an initialisation rejected with undefined was exposed as ready");
  assert.equal(projects.initialProjectContextFailed(), true,
    "an initialisation rejected with undefined was not recorded as failed");
});

test("a remote open leaves publication to the owning window", async () => {
  const previous = projects.active().id;
  const remote = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  openLocal = false;
  const before = hostCalls.length;
  await projects.activate(remote);
  const callerNotifications = hostCalls.slice(before);
  assert.ok(callerNotifications.every(({ id }) => id !== remote),
    "the requesting window published the project owned by another window");
  assert.equal(projects.active()?.id, previous);

  openLocal = true;
  await activateTarget(remote);
});

test("a failed project publication restores the previous project-data owner", async () => {
  const previous = projects.active().id;
  failShown = true;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  await assert.rejects(projects.activate(next), /native project publication failed/);
  assert.equal(projects.active()?.id, previous, "a failed publication changed the active project");
  assert.ok(released.includes(next), "a failed publication left its staged native owner registered");
  failShown = false;
});

test("a failed settings selection does not publish or replace the previous project context", async () => {
  const previous = projects.active().id;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  const before = hostCalls.length;
  failSelection = next;
  await assert.rejects(projects.activate(next), /settings project selection failed/);
  failSelection = null;
  assert.equal(projects.active()?.id, previous, "a failed settings selection changed the active project");
  assert.equal(selectedProject, previous, "a failed settings selection was not rolled back");
  assert.equal(nativeShown?.id, previous, "a failed settings selection changed the native shown project");
  assert.equal(hostCalls.slice(before).some(({ id, source }) => id === next && source === "project shown notification"), false,
    "a failed settings selection published the project before the Workbench was ready");
  assert.ok(released.includes(next), "a failed settings selection left its staged native owner registered");
});

test("a native open failure keeps the previous project-data owner", async () => {
  const previous = projects.active().id;
  failOpen = true;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  await assert.rejects(projects.activate(next), /native project open failed/);
  assert.equal(projects.active()?.id, previous, "a failed native open changed the page's active project");
  await projects.flush();
});
