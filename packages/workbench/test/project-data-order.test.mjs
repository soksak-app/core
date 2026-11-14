// Checks the project switch against the native project-open and project-shown notifications.
// The host calls of the page are answered by the page-wire case project-data-order-session (docs/spec/cases/page-wire/README.md): the
// tests of this file run in the order of the case, and each test plays its steps. The case is selected before the modules are imported,
// because the page reads the host when it imports them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const layout = { state: { cards: [] } };
const projectsSnapshot = [
  { id: "prj-alpha", root: "/work/alpha", identity: "alpha", title: "alpha", color: "#fff", named: 1,
    activeSpaceId: "spc-alpha", spaces: [{ id: "spc-alpha", title: "SPACE1", layout }],
    plugins: { probe: { label: { format: 1, value: "alpha data" } } }, settings: {} },
  { id: "prj-beta", root: "/work/beta", identity: "beta", title: "beta", color: "#fff", named: 1,
    activeSpaceId: "spc-beta", spaces: [{ id: "spc-beta", title: "SPACE1", layout }],
    plugins: { probe: { label: { format: 1, value: "beta data" } } }, settings: {} },
];
// The stored settings store the operations of the page (the class call) and the start of the document (the class lifecycle).
const COMMON = { "diagnostics.log": { lifecycle: "info", call: "info" } };
const snapshotOf = () => ({ common: structuredClone(COMMON), projects: structuredClone(projectsSnapshot), open: [] });

const wire = selectPageWire("project-data-order-session");

// The window of the page: its address, its history and the error event that the page reports failures through.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://soksak.test/index.html" });
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.history = dom.window.history;
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.ErrorEvent = dom.window.ErrorEvent;
/** Gives the window the address of a test: the page of a project names it in its search, the library has none. */
const locate = (search) => history.replaceState(null, "", `/index.html${search}`);

const projects = await import("../projects.js");
const { orderedCallsAnswered } = await import("../host.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { connectSettings, settingProject } = await import("../settings.js");
const { flushEvents, recordWorkbenchStart } = await import("../page-log.js");

let contextPendingAtLibraryEmpty = false;
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

// The start of the page: the first screen is the library, the settings connect to the store of the host, and the start of the document
// is the first event that leaves the log.
projects.begin(snapshotOf());
await orderedCallsAnswered();
const store = new HostWorkspaceStore(host);
await connectSettings(store);
recordWorkbenchStart(location, performance.timeOrigin);
await flushEvents();

/** The calls of the page that a host call name selects, from the call at index `from` on. */
const callsOf = (name, from = 0) => wire.calls.slice(from).filter((call) => call.name === name);
/** The ids of the projects that the calls from index `from` on published as shown, null for the library. */
const shownIn = (from) => callsOf("projectShown", from).map(({ payload }) => payload.project?.id ?? null);

test("a page start without a project does not wait for project context", async () => {
  locate("");
  projects.begin(snapshotOf());
  await orderedCallsAnswered();
  assert.equal(projects.initialProjectContextReady(), true);
  await projects.waitForInitialProjectContext();
});

test("a failed first activation releases startup waiters after the preview is cleared", async () => {
  locate("?project=prj-alpha");
  projects.begin(snapshotOf());
  await orderedCallsAnswered();
  const initialContext = projects.waitForInitialProjectContext();
  await projects.initialise(store);
  await initialContext;

  assert.equal(contextPendingAtLibraryEmpty, true,
    "the initial context gate opened before leaveBegun cleared the preview layout");
  assert.equal(projects.initialProjectContextReady(), true);
  assert.equal(projects.active(), null, "a rejected first activation left the preview project active");
});

test("a failed initialisation rejects the startup context without marking it ready", async () => {
  locate("?project=prj-alpha");
  projects.begin(snapshotOf());
  await orderedCallsAnswered();
  const initialContext = projects.waitForInitialProjectContext();
  await assert.rejects(projects.initialise(store), /tab-state store open failed/);
  await assert.rejects(initialContext, /tab-state store open failed/);
  assert.equal(projects.initialProjectContextReady(), false,
    "a rejected startup context was exposed as ready to later view and background-session work");
});

// The host answers a read of the tab state file with an error, and the wire gives the page only the text of that error; the page
// stores nothing of the error it receives, so the one failure that the wire cannot give is a rejection with undefined. This store
// is the store of the host except for that read, which is the named point of the fault.
class UndefinedRejection extends HostWorkspaceStore {
  tabState() { return Promise.reject(undefined); }
}

test("an initialisation rejected with undefined does not resolve the startup context", async () => {
  locate("?project=prj-alpha");
  projects.begin(snapshotOf());
  await orderedCallsAnswered();
  const initialContext = projects.waitForInitialProjectContext();
  await assert.rejects(projects.initialise(new UndefinedRejection(host)), (reason) => reason === undefined);
  await assert.rejects(initialContext, (reason) => reason === undefined);
  assert.equal(projects.initialProjectContextReady(), false,
    "an initialisation rejected with undefined was exposed as ready");
  assert.equal(projects.initialProjectContextFailed(), true,
    "an initialisation rejected with undefined was not recorded as failed");
});

test("a remote open leaves publication to the owning window", async () => {
  const previous = projects.active().id;
  const remote = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  const before = wire.calls.length;
  await projects.activate(remote);
  assert.ok(shownIn(before).every((id) => id !== remote),
    "the requesting window published the project owned by another window");
  assert.equal(projects.active()?.id, previous);

  // The owning window tells this window to show the project: the host sends the activation notice.
  wire.deliverNotice();
  await drained();
});

test("a failed project publication restores the previous project-data owner", async () => {
  const previous = projects.active().id;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  const before = wire.calls.length;
  await assert.rejects(projects.activate(next), /native project publication failed/);
  assert.equal(projects.active()?.id, previous, "a failed publication changed the active project");
  assert.ok(callsOf("projectRelease", before).some(({ payload }) => payload === next), "a failed publication left its staged native owner registered");
});

test("a failed settings selection does not publish or replace the previous project context", async () => {
  const previous = projects.active().id;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  const before = wire.calls.length;
  await assert.rejects(projects.activate(next), /settings project selection failed/);
  assert.equal(projects.active()?.id, previous, "a failed settings selection changed the active project");
  assert.equal(settingProject(), previous, "a failed settings selection was not rolled back");
  assert.deepEqual(shownIn(before), [], "a failed settings selection changed the native shown project");
  assert.equal(shownIn(before).includes(next), false,
    "a failed settings selection published the project before the Workbench was ready");
  assert.ok(callsOf("projectRelease", before).some(({ payload }) => payload === next), "a failed settings selection left its staged native owner registered");
});

test("a native open failure keeps the previous project-data owner", async () => {
  const previous = projects.active().id;
  const next = previous === "prj-alpha" ? "prj-beta" : "prj-alpha";
  await assert.rejects(projects.activate(next), /native project open failed/);
  assert.equal(projects.active()?.id, previous, "a failed native open changed the page's active project");
  await projects.flush();
  await drained();
  wire.finish();
});
