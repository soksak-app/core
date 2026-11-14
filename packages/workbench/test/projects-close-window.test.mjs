// A window close request asks for each modified tab before the projects are saved and the window closes
// (docs/spec/plugins.md#tab-reports).
// The host calls and the notices of the page are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). The
// case of the setup is selected before the modules are imported, because the page reads the host when it imports them. Each test starts
// the page over its own case: it connects the settings and starts the project list to the store of that case, and the state of the
// project list that the earlier tests left stands as the case of the test records it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const PROJECT = {
  id: "prj-one", root: "/work/one", identity: "1:1", title: "one", color: "#fff", named: 1,
  activeSpaceId: "spc-one", spaces: [{ id: "spc-one", title: "SPACE1", layout: { state: { cards: [], name: "one" } } }], settings: {},
};
// The stored settings store the operations of the page (the class call) and the start of the document (the class lifecycle).
const COMMON = { "diagnostics.log": { lifecycle: "info", call: "info" } };
const POLICY = { lifecycle: "info", input: "error", call: "info", io: "error", frame: "error" };

let wire = selectPageWire("projects-close-window-start");

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
const { connectSettings, set } = await import("../settings.js");
const { logGate } = await import("../log-gate.js");
const { flushEvents, recordWorkbenchStart } = await import("../page-log.js");

/* Whether the person keeps a modified tab; the question is recorded in `order` and `asks`. */
let kept = false;
/* The questions and the emptied planes in the order of the callbacks, and the number of host calls at each question. */
const order = [];
const asks = [];
projects.onSwitch({
  check: () => {}, save: () => PROJECT.spaces[0].layout, load: () => {}, update: () => {}, retain: async () => {},
  presented: async () => {}, empty: async () => { order.push("empty"); },
  settleTabs: async () => { order.push("ask"); asks.push(wire.calls.length); return !kept; },
});

// The start of the page: the first screen is the library, and the start of the document is the first event that leaves the log.
projects.begin({ common: structuredClone(COMMON), projects: [], open: [] });
await orderedCallsAnswered();
logGate.set(POLICY);
recordWorkbenchStart(location, performance.timeOrigin);
await flushEvents();
wire.finish();

/** Starts the page over the case of a test: the settings and the project list connect to the store of that case, so no call of the page reaches the case of an earlier test. */
async function start(name) {
  wire = selectPageWire(name);
  order.length = 0;
  asks.length = 0;
  const store = new HostWorkspaceStore(host);
  await connectSettings(store);
  await projects.initialise(store);
}

/** The names of the host calls of the page from the call at index `from` on. */
const namesFrom = (from) => wire.calls.slice(from).map(({ name }) => name);
/** The calls of the page from index `from` on that carry the host call name. */
const callsFrom = (from, name) => wire.calls.slice(from).filter((call) => call.name === name);
const isRemove = ({ name, payload }) => name === "workspace" && payload.kind === "remove";
/** The events of the log batches that the page sent from index `from` on. */
const eventsFrom = (from) => callsFrom(from, "log").filter(({ payload }) => payload.action === "batch").flatMap(({ payload }) => payload.events);

// On a first run the starter install emits a plugin change before the page initialises its projects (F199.4).
test("flushing the projects before initialise fails with an explicit error", async () => {
  await assert.rejects(projects.flush(), { message: "projects.flush: the projects are not initialised" });
});

test("a window close request asks about modified tabs before it saves and closes", async () => {
  await start("projects-close-window-asks-first");
  await projects.activate(PROJECT.id);
  order.length = 0;
  asks.length = 0;
  kept = false;
  const from = wire.calls.length;
  wire.deliverNotice();
  await drained();
  assert.deepEqual(order, ["ask"]);
  assert.equal(asks[0], from, `the window saved or closed before the question: ${namesFrom(from)}`);
  assert.equal(wire.calls.at(-1).name, "windowClose");
  assert.deepEqual(reported, []);
  wire.finish();
});

test("a kept modified tab keeps the window open and unsaved", async () => {
  await start("projects-close-window-kept");
  kept = true;
  const from = wire.calls.length;
  wire.deliverNotice();
  await drained();
  assert.deepEqual(order, ["ask"]);
  assert.equal(asks[0], from);
  // The kept close reports to the host and leaves the operation of the close in the log; the page stores and closes nothing.
  assert.deepEqual(namesFrom(from), ["windowCloseKept", "log"], "a kept tab did not report the kept close to the host");
  wire.finish();
});

test("removing the project shown in the window asks about modified tabs before it removes the project", async () => {
  await start("projects-close-window-remove-shown");
  kept = true;
  const from = wire.calls.length;
  assert.equal(await projects.close(PROJECT.id), false);
  assert.deepEqual(order, ["ask"], "a kept modified tab did not keep the project");
  assert.deepEqual(namesFrom(from), [], "a kept modified tab sent a host call");
  kept = false;
  order.length = 0;
  asks.length = 0;
  const second = wire.calls.length;
  assert.equal(await projects.close(PROJECT.id), true);
  await drained();
  assert.equal(order[0], "ask", `the project was saved or removed before the question: ${order}`);
  assert.equal(asks[0], second, `the project was saved or removed before the question: ${namesFrom(second)}`);
  assert.ok(wire.calls.slice(second).some(isRemove));
  wire.finish();
});

test("removing a project that another window shows asks that window and keeps the project when it refuses", async () => {
  await start("projects-close-window-remove-elsewhere");
  await projects.browse();
  const from = wire.calls.length;
  // The host answers the first question of the owner window with a refusal and the second with the permission.
  assert.equal(await projects.close(PROJECT.id), false);
  await drained();
  assert.deepEqual(namesFrom(from), ["projectRemoveAsk", "log"], "the refusal of the owner window did not keep the project");
  assert.equal(wire.calls[from].payload, PROJECT.id);
  const second = wire.calls.length;
  assert.equal(await projects.close(PROJECT.id), true);
  await drained();
  assert.equal(wire.calls[second].name, "projectRemoveAsk");
  assert.equal(wire.calls[second].payload, PROJECT.id);
  assert.ok(wire.calls.slice(second).some(isRemove));
  wire.finish();
});

test("a removal request for the project shown here asks about modified tabs and answers the host", async () => {
  await start("projects-close-window-remove-request");
  await projects.activate(PROJECT.id);
  const answered = (from) => callsFrom(from, "projectRemoveAnswer").map(({ payload }) => payload);
  order.length = 0;
  asks.length = 0;
  kept = true;
  let from = wire.calls.length;
  wire.deliverNotice();
  await drained();
  assert.deepEqual(order, ["ask"]);
  assert.equal(asks[0], from);
  assert.deepEqual(answered(from), [{ id: PROJECT.id, allowed: false }]);
  order.length = 0;
  asks.length = 0;
  kept = false;
  from = wire.calls.length;
  wire.deliverNotice();
  await drained();
  assert.deepEqual(order, ["ask"]);
  assert.equal(asks[0], from);
  assert.deepEqual(answered(from), [{ id: PROJECT.id, allowed: true }]);
  // A project that the library shows has no tab in the plane, so the answer needs no question.
  await projects.browse();
  order.length = 0;
  from = wire.calls.length;
  wire.deliverNotice();
  await drained();
  assert.deepEqual(order, []);
  assert.deepEqual(namesFrom(from), ["projectRemoveAnswer"]);
  assert.deepEqual(answered(from), [{ id: PROJECT.id, allowed: true }]);
  wire.finish();
});

test("opening a project, removing it, opening a window and closing it are operations whose identifiers go with their host calls", async () => {
  await start("projects-close-window-operation-cids");
  const from = wire.calls.length;
  kept = false;
  await projects.activate(PROJECT.id);
  await projects.newWindow();
  await projects.close(PROJECT.id);
  // Another window adds the project again: the host announces the registry change and the window reads the registry.
  wire.deliverNotice();
  await projects.idle();
  await projects.activate(PROJECT.id);
  wire.deliverNotice();
  await drained();
  kept = true;
  wire.deliverNotice();
  await drained();
  await flushEvents();
  // The first events of the operations, as the log batches carry them.
  const started = eventsFrom(from).map(({ event, fields, cids }) => [event, fields, cids]);
  const operation = (event, action) => started.filter(([name, fields]) => name === event && fields.action === action).map(([, , cids]) => cids);
  const [opened] = operation("workbench.project.operation", "open");
  const [removed] = operation("workbench.project.operation", "remove");
  const [newWindow] = operation("workbench.window.operation", "new");
  const [closed] = operation("workbench.window.operation", "close");
  const [closedKept] = operation("workbench.window.operation", "close_kept");
  for (const cids of [opened, removed, newWindow, closed, closedKept]) assert.match(cids?.[0] ?? "", /^p[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+$/);
  assert.equal(new Set([opened, removed, newWindow, closed, closedKept].map((cids) => cids[0])).size, 5, "an operation took the identifier of another");
  const cidsOf = (name) => callsFrom(from, name).map(({ cids }) => cids);
  assert.deepEqual(cidsOf("projectOpen")[0], opened);
  assert.deepEqual(cidsOf("windowNew"), [newWindow]);
  assert.deepEqual(cidsOf("projectRelease")[0], removed);
  assert.deepEqual(cidsOf("windowClose").at(-1), closed);
  assert.deepEqual(cidsOf("windowCloseKept"), [closedKept]);
  assert.deepEqual(started.find(([event, fields]) => event === "workbench.project.operation" && fields.action === "open")[1], { action: "open", project: PROJECT.id });
  assert.deepEqual(started.find(([event, fields]) => event === "workbench.project.operation" && fields.action === "remove")[1], { action: "remove", project: PROJECT.id });
  wire.finish();
});

test("the page flushes its event queue after the operation of the close starts and before its host call", async () => {
  await start("projects-close-window-log-flush");
  await projects.activate(PROJECT.id);
  kept = false;
  // A settings write that the host has not answered stands when the close request arrives; the close saves the settings first.
  const saving = set({ left: false }, "common", "core.settings.set");
  await orderedCallsAnswered();
  await drained();
  order.length = 0;
  asks.length = 0;
  const from = wire.calls.length;
  wire.deliverNotice();
  await drained();
  assert.deepEqual(order, ["ask"]);
  assert.equal(asks[0], from);
  assert.equal(wire.calls.length, from, "the window stored the geometry or closed before the settings write ended");
  wire.release();
  await saving;
  await drained();
  // The window ends with the call, so the queue that the drain hands to the writer of the host must already hold the first
  // event of the operation (F161.26): the batch that carries it stands between the geometry and the close.
  const sent = wire.calls.slice(from);
  assert.deepEqual(sent.map(({ name }) => name), ["workspace", "windowState", "log", "windowClose"],
    `the settings read, the geometry, the drain and the close ran in another order: ${namesFrom(from)}`);
  assert.deepEqual(sent[0].payload, { kind: "snapshot" });
  assert.deepEqual(eventsFrom(from).map(({ event, fields }) => [event, fields]), [["workbench.window.operation", { action: "close" }]]);
  assert.deepEqual(sent[3].cids, eventsFrom(from)[0].cids);
  wire.finish();
});

test("a close request that follows a registry change without the shown project asks after the window ends that project", async () => {
  // Another window removed the project after this window answered its question; the registry change reaches this window
  // before the close request, and the read of the registry is still running when the request arrives (F292-50).
  await start("projects-close-window-registry-change");
  await projects.activate(PROJECT.id);
  kept = false;
  order.length = 0;
  asks.length = 0;
  // The host answers the read of the registry that the change started after the close request arrived.
  wire.deliverNotice();
  wire.deliverNotice();
  await drained();
  assert.deepEqual(order, [], "the close asked about the tabs before the read of the registry ended");
  wire.release();
  await drained();
  assert.ok(order.includes("empty"), `the window did not end the removed project: ${order}`);
  assert.ok(order.indexOf("empty") < order.indexOf("ask"),
    `the close asked about the tabs of the removed project before the window ended it: ${order}`);
  assert.equal(wire.calls.at(-1).name, "windowClose");
  assert.deepEqual(reported, []);
  wire.finish();
});
