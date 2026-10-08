// A window close request asks for each modified tab before the projects are saved and the window closes
// (docs/spec/plugins.md#tab-reports).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 1,
  activeSpaceId: "spc-one", spaces: [{ id: "spc-one", title: "SPACE1", layout: { state: { cards: [], name: "one" } } }], settings: {},
};

/* The order of the saves, the questions and the window close. */
const events = [];
let requestClose = null;
mock.module("@soksak/runtime", {
  namedExports: {
    windows: {
      folder: async (root) => ({ root, identity: PROJECT.identity }),
      openProject: async () => ({ local: true }),
      releaseProject: async () => {},
      state: async () => { events.push("geometry"); return null; },
      close: async () => { events.push("close"); },
      releaseProject: async () => { events.push("release"); },
      closeKept: async () => { events.push("kept"); },
      ready: async () => {},
      onActivate: async () => {},
      onCloseRequest: async (fn) => { requestClose = fn; },
    },
  },
});
mock.module("../host.js", {
  namedExports: { log: () => {}, retainSidecarSessions: async () => ({ closed: 0 }), windowSidecar: () => null },
});
mock.module("../plugin-states.js", {
  namedExports: { configureStates: () => {}, showStates: async () => {} },
});
mock.module("../settings.js", {
  namedExports: {
    beginSettings: () => {}, selectProject: async () => {}, value: () => "tabs",
    flushSettings: async () => { events.push("settings"); },
  },
});
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };
globalThis.location = new URL("http://soksak.test/index.html");
globalThis.history = { replaceState: () => {} };

const projects = await import("../projects.js");

/* Whether the person keeps a modified tab; the question is recorded in events. */
let kept = false;
projects.onSwitch({
  check: () => {}, save: () => PROJECT.spaces[0].layout, load: () => {}, update: () => {}, retain: async () => {},
  presented: async () => {}, empty: async () => {},
  settleTabs: async () => { events.push("ask"); return !kept; },
});
const store = {
  snapshot: async () => ({ common: {}, projects: [structuredClone(PROJECT)], open: [] }),
  add: async () => { throw new Error("not used"); },
  patch: async () => { events.push("patch"); },
  remove: async () => { events.push("remove"); },
  onChange: () => {},
};

test("a window close request asks about modified tabs before it saves and closes", async () => {
  await projects.initialise(store);
  await projects.activate(PROJECT.id);
  events.length = 0;
  kept = false;
  await requestClose();
  assert.equal(events[0], "ask", `the window saved or closed before the question: ${events}`);
  assert.equal(events.at(-1), "close");
  assert.deepEqual(reported, []);
});

test("a kept modified tab keeps the window open and unsaved", async () => {
  events.length = 0;
  kept = true;
  await requestClose();
  assert.deepEqual(events, ["ask", "kept"], "a kept tab did not report the kept close to the host");
});

test("removing the project shown in the window asks about modified tabs before it removes the project", async () => {
  events.length = 0;
  kept = true;
  assert.equal(await projects.close(PROJECT.id), false);
  assert.deepEqual(events, ["ask"], "a kept modified tab did not keep the project");
  kept = false;
  events.length = 0;
  assert.equal(await projects.close(PROJECT.id), true);
  assert.equal(events[0], "ask", `the project was saved or removed before the question: ${events}`);
  assert.ok(events.includes("remove"));
});
