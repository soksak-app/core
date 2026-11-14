// Renaming a space of the active project (core.space.rename): a known id takes the title, and an id that is no space of the project
// is an error that names it (docs/spec/projects.md#persistence).
// The host calls of the page are answered by the page-wire case space-rename-session (docs/spec/cases/page-wire/README.md). The case is
// selected before the modules are imported, because the page reads the host when it imports them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 2, activeSpaceId: "spc-one",
  spaces: [
    { id: "spc-one", title: "SPACE1", layout: { state: { cards: [], name: "one" } } },
    { id: "spc-two", title: "SPACE2", layout: { state: { cards: [], name: "two" } } },
  ],
  settings: {},
};
// The stored settings store the operations of the page (the class call) and the start of the document (the class lifecycle).
const COMMON = { "diagnostics.log": { lifecycle: "info", call: "info" } };
const SNAPSHOT = { common: COMMON, projects: [PROJECT], open: [] };

const wire = selectPageWire("space-rename-session");

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

const projects = await import("../projects.js");
const { orderedCallsAnswered } = await import("../host.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { connectSettings } = await import("../settings.js");
const { flushEvents, recordWorkbenchStart } = await import("../page-log.js");

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

// The start of the page: the first screen is the library, the settings and the project list connect to the store of the host, and the
// start of the document is the first event that leaves the log.
projects.begin(structuredClone(SNAPSHOT));
await orderedCallsAnswered();
const store = new HostWorkspaceStore(host);
await connectSettings(store);
recordWorkbenchStart(location, performance.timeOrigin);
await flushEvents();
await projects.initialise(store);

test("a space of the active project takes its new title, and an unknown space id is an error that names it", async () => {
  await projects.activate(PROJECT.id);
  projects.renameSpace("spc-two", "Work");
  assert.deepEqual(projects.active().spaces.map((space) => [space.id, space.title]), [["spc-one", "SPACE1"], ["spc-two", "Work"]]);
  assert.throws(() => projects.renameSpace("spc-missing", "Notes"),
    (error) => error.constructor === Error && error.message === "Unknown space: spc-missing");
  assert.deepEqual(projects.active().spaces.map((space) => space.title), ["SPACE1", "Work"]);
  assert.deepEqual(reported, []);
  // The rename stores the layout of the project with the new title: the case holds that write, which the page sends after the turn.
  await drained();
  wire.finish();
});
