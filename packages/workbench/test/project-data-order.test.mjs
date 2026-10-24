// Checks project-data calls against the native project-open notification boundary.
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

let pluginHostData;
const hostCalls = [];
const released = [];
let failOpen = false;
let failShown = false;
let failSelection = null;
let selectedProject = null;
let holdShown = false;
let shownEnteredResolve;
let releaseShown;
let transitionCall;
let openLocal = true;
let activateTarget = null;
let nativeShown = null;
let catchUpDuringOpen = false;
mock.module("@soksak/runtime", {
  namedExports: {
    windows: {
      folder: async (root) => ({ root, identity: root === "/work/alpha" ? "alpha" : "beta" }),
      openProject: async ({ id }) => {
        if (failOpen) throw new Error("native project open failed");
        if (catchUpDuringOpen) {
          const shown = nativeShown;
          const call = pluginHostData.get("probe", "label").then(
            (value) => ({ value }),
            (error) => ({ error: error.message }),
          );
          hostCalls.push({ id: shown?.id ?? null, source: "ready catch-up before projectShown", call });
        }
        return { local: openLocal, staged: openLocal && nativeShown?.id !== id };
      },
      projectShown: async (project) => {
        if (failShown) throw new Error("native project publication failed");
        nativeShown = project;
        if (holdShown) {
          transitionCall = pluginHostData.get("probe", "label").then(
            (value) => ({ value }),
            (error) => ({ error: error.message }),
          );
          shownEnteredResolve();
          await new Promise((resolve) => { releaseShown = resolve; });
        }
        const call = pluginHostData.get("probe", "label").then(
          (value) => ({ value }),
          (error) => ({ error: error.message }),
        );
        hostCalls.push({ id: project?.id ?? null, source: "project shown notification", call });
      },
      releaseProject: async (id) => { released.push(id); },
      state: async () => null,
      close: async () => {},
      onRemoveProjectRequest: async () => {},
      askRemoveProject: async () => true,
      answerRemoveProject: async () => {},
      ready: async () => {
        const shown = nativeShown;
        const call = pluginHostData.get("probe", "label").then(
          (value) => ({ value }),
          (error) => ({ error: error.message }),
        );
        hostCalls.push({ id: shown?.id ?? null, source: "window ready catch-up", call });
      },
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
  namedExports: { beginSettings: (_snapshot, id) => { selectedProject = id; }, selectProject: async (id) => {
    selectedProject = id;
    if (id === failSelection) throw new Error("settings project selection failed");
  }, value: () => "tabs", flushSettings: async () => {} },
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

globalThis.dispatchEvent = () => true;
globalThis.location = new URL("http://soksak.test/index.html?project=prj-alpha");
globalThis.history = { replaceState: (state, title, url) => { globalThis.location = new URL(url, globalThis.location); } };

const data = await import("../plugin-data.js");
pluginHostData = data.pluginHostData;
data.declareProjectData("probe", { label: { schema: { type: "string" }, default: "" } });
const projects = await import("../projects.js");

const plane = { layout: null };
projects.onSwitch({
  check: () => {},
  save: () => plane.layout ?? layout,
  load: (next) => { plane.layout = next; },
  update: () => {},
  retain: async () => {},
  presented: async () => {},
  empty: async (show) => { plane.layout = null; show?.(); },
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

test("a ready plugin host receives project data after initial project data is prepared", async () => {
  projects.begin({ common: {}, projects: structuredClone(projectsSnapshot), open: [] });
  await projects.initialise(store);

  assert.equal(projects.active()?.id, "prj-alpha");
  assert.deepEqual(await hostCalls.find(({ source }) => source === "window ready catch-up").call, { value: "alpha data" },
    "the initial window-ready project catch-up ran before project data was prepared");
  assert.deepEqual(await hostCalls.find(({ source }) => source === "project shown notification").call, { value: "alpha data" },
    "the initial plugin-host project callback ran before the page loaded project data");
  assert.equal(nativeShown.id, "prj-alpha");
});

test("a project switch delivers the new project's data to its plugin host", async () => {
  await projects.activate("prj-beta");
  assert.deepEqual(await hostCalls.find(({ id, source }) => id === "prj-beta" && source === "project shown notification").call, { value: "beta data" },
    "the switched plugin-host project callback did not read the new project's data");
  assert.equal(projects.active()?.id, "prj-beta");
});

test("plugin callbacks during native project publication read the prepared project context", async () => {
  let entered;
  holdShown = true;
  entered = new Promise((resolve) => { shownEnteredResolve = resolve; });
  const next = projects.active().id === "prj-alpha" ? "prj-beta" : "prj-alpha";
  const activation = projects.activate(next);
  await entered;
  const expected = `${next === "prj-alpha" ? "alpha" : "beta"} data`;
  assert.deepEqual(await transitionCall, { value: expected },
    "a callback delivered during projectShown did not read the prepared project context");
  assert.equal(await pluginHostData.get("probe", "label"), expected,
    "a call issued during the publication gap did not use the installed project context");
  releaseShown();
  await activation;
  holdShown = false;
  assert.equal(await pluginHostData.get("probe", "label"), expected);
});

test("a host that becomes ready after projectOpen but before projectShown catches up to the previous project", async () => {
  catchUpDuringOpen = true;
  const previous = projects.active().id;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  await projects.activate(next);
  catchUpDuringOpen = false;
  const catchUp = hostCalls.findLast(({ source }) => source === "ready catch-up before projectShown");
  assert.equal(catchUp.id, previous, "ready catch-up observed an uncommitted native project");
  assert.deepEqual(await catchUp.call, { value: `${previous === "prj-alpha" ? "alpha" : "beta"} data` },
    "ready catch-up used an uncommitted data context");
  assert.deepEqual(await hostCalls.findLast(({ id, source }) => id === next && source === "project shown notification").call,
    { value: `${next === "prj-alpha" ? "alpha" : "beta"} data` }, "the later projectShown did not publish the new context");
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
  assert.deepEqual(await hostCalls.findLast(({ id, source }) => id === remote && source === "project shown notification").call,
    { value: `${remote === "prj-alpha" ? "alpha" : "beta"} data` }, "the owning window did not publish after preparing its project data");
});

test("a failed project publication restores the previous project-data owner", async () => {
  const previous = projects.active().id;
  const expected = previous === "prj-alpha" ? "alpha data" : "beta data";
  failShown = true;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  await assert.rejects(projects.activate(next), /native project publication failed/);
  assert.equal(projects.active()?.id, previous, "a failed publication changed the active project");
  assert.equal(await pluginHostData.get("probe", "label"), expected,
    "a failed publication left the prepared project-data context active");
  assert.ok(released.includes(next), "a failed publication left its staged native owner registered");
  failShown = false;
});

test("a failed settings selection does not publish or replace the previous project context", async () => {
  const previous = projects.active().id;
  const expected = previous === "prj-alpha" ? "alpha data" : "beta data";
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  const before = hostCalls.length;
  failSelection = next;
  await assert.rejects(projects.activate(next), /settings project selection failed/);
  failSelection = null;
  assert.equal(projects.active()?.id, previous, "a failed settings selection changed the active project");
  assert.equal(selectedProject, previous, "a failed settings selection was not rolled back");
  assert.equal(nativeShown?.id, previous, "a failed settings selection changed the native shown project");
  assert.equal(await pluginHostData.get("probe", "label"), expected,
    "a failed settings selection changed the active data context");
  assert.equal(hostCalls.slice(before).some(({ id, source }) => id === next && source === "project shown notification"), false,
    "a failed settings selection published the project before the Workbench was ready");
  assert.ok(released.includes(next), "a failed settings selection left its staged native owner registered");
});

test("a native open failure keeps the previous project-data owner", async () => {
  const previous = projects.active().id;
  const expected = previous === "prj-alpha" ? "alpha data" : "beta data";
  failOpen = true;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  await assert.rejects(projects.activate(next), /native project open failed/);
  assert.equal(projects.active()?.id, previous, "a failed native open changed the page's active project");
  assert.equal(await pluginHostData.get("probe", "label"), expected,
    "a failed native open changed the project-data owner");
  await projects.flush();
});
