// The page follows the status that a plugin declares as surface.program on the surface of each tab of its window by a watch of that
// surface, and reports the program state of each tab (docs/spec/program-state.md#following, docs/spec/program-state.md#status). The
// host calls are answered by a page-wire case (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const imports = selectPageWire("exposure-none");
const { createRegistry } = await import("../exposure.js");
const { createActivity, tabProgram } = await import("../activity.js");
imports.finish();

const PROGRAM = {
  name: "probe.program",
  description: "The program state of the probe.",
  schema: {
    type: ["object", "null"],
    required: ["state"],
    properties: {
      state: { type: "string", enum: ["idle", "working", "blocked"] },
      pid: { type: ["integer", "null"] },
      app: { type: ["string", "null"] },
    },
  },
};

/** The window of one project whose one space holds the tabs in one card, in the stored form. */
const windowOf = (tabs) => [{ id: "p1", spaces: [{ id: "s1", layout: { state: { root: { card: "card-1", data: { tabs } } } } }] }];

const otherError = (value) => `probe exposes probe.program on tab tab-a: program value ${value} is not null or an object with only the members state, pid and app, where state is one of idle, working, blocked, pid is a positive integer or null and app is a text of 1 to 64 characters or null`;

test("tabProgram gives the state, the pid and the app of an object with the members state, pid and app, none for null, and the text for another value", () => {
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle", pid: 7, app: null }), { program: { state: "idle", pid: 7, app: null }, error: null });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle", pid: 7 }), { program: null, error: otherError('{"state":"idle","pid":7}') });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle", pid: 7, app: "" }), { program: null, error: otherError('{"state":"idle","pid":7,"app":""}') });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle", pid: 7, app: "x".repeat(65) }), { program: null, error: otherError(`{"state":"idle","pid":7,"app":"${"x".repeat(65)}"}`) });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "blocked", pid: 42, app: "codex" }), { program: { state: "blocked", pid: 42, app: "codex" }, error: null });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle", pid: null, app: "codex" }), { program: { state: "idle", pid: null, app: "codex" }, error: null });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", null), { program: null, error: null });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "busy", pid: 1, app: "codex" }), { program: null, error: otherError('{"state":"busy","pid":1,"app":"codex"}') });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle" }), { program: null, error: otherError('{"state":"idle"}') });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle", pid: 0, app: "codex" }), { program: null, error: otherError('{"state":"idle","pid":0,"app":"codex"}') });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle", pid: 1.5, app: "codex" }), { program: null, error: otherError('{"state":"idle","pid":1.5,"app":"codex"}') });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", { state: "idle", pid: 1, app: "codex", extra: 1 }), { program: null, error: otherError('{"state":"idle","pid":1,"app":"codex","extra":1}') });
  assert.deepEqual(tabProgram("probe", "probe.program", "tab-a", "working"), { program: null, error: otherError('"working"') });
});

test("the program state of a tab follows the watch of its surface, which starts when the tab shows and ends when the tab leaves", { timeout: 5000 }, async () => {
  const wire = selectPageWire("program-follow-watches");
  const made = createRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("probe", { status: [PROGRAM] });
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.program" });
  made.registered({ surface: "tab-b", kind: "status", name: "probe.program" });
  let projects = windowOf([{ id: "tab-a", plugin: "probe" }, { id: "tab-b", plugin: "probe" }]);
  let changes = 0;
  const errors = [];
  const activity = createActivity({
    observe: (name, surface, fn) => made.observe(name, surface, fn, { exact: true }),
    statuses: () => [],
    programStatus: (plugin) => (plugin === "probe" ? PROGRAM.name : null),
    projects: () => projects,
    changed: () => { changes += 1; },
    failed: () => {},
    programFailed: (tab, text) => errors.push([tab, text]),
    publish: () => {},
  });
  activity.sync();
  await made.idle();
  assert.deepEqual(activity.programs(), {}, "no surface sent a value");
  assert.deepEqual(activity.state(), { spaces: {}, tabs: {} }, "a program state is no activity");
  made.changed({ surface: "tab-a", name: "probe.program", value: { state: "working", pid: 101, app: "codex" }, version: 1 });
  assert.deepEqual(activity.programs(), { "tab-a": { state: "working", pid: 101, app: "codex" } });
  made.changed({ surface: "tab-b", name: "probe.program", value: { state: "idle", pid: null, app: "codex" }, version: 1 });
  assert.deepEqual(activity.programs(), { "tab-a": { state: "working", pid: 101, app: "codex" }, "tab-b": { state: "idle", pid: null, app: "codex" } });
  made.changed({ surface: "tab-a", name: "probe.program", value: { state: "blocked", pid: 101, app: "codex" }, version: 2 });
  assert.deepEqual(activity.programs()["tab-a"], { state: "blocked", pid: 101, app: "codex" });
  assert.equal(changes, 3, "each change of a program state is announced once");
  // A value outside the program states gives tab-a no state and shows its error until a valid value withdraws it.
  made.changed({ surface: "tab-a", name: "probe.program", value: { state: "busy", pid: 101, app: "codex" }, version: 3 });
  assert.deepEqual(activity.programs(), { "tab-b": { state: "idle", pid: null, app: "codex" } });
  assert.deepEqual(errors, [["tab-a", otherError('{"state":"busy","pid":101,"app":"codex"}')]]);
  made.changed({ surface: "tab-a", name: "probe.program", value: { state: "idle", pid: 101, app: "codex" }, version: 4 });
  assert.deepEqual(activity.programs(), { "tab-a": { state: "idle", pid: 101, app: "codex" }, "tab-b": { state: "idle", pid: null, app: "codex" } });
  assert.deepEqual(errors.at(-1), ["tab-a", null]);
  // tab-a leaves the layouts, so its watch ends and its state is gone.
  projects = windowOf([{ id: "tab-b", plugin: "probe" }]);
  activity.sync();
  await made.idle();
  assert.deepEqual(activity.programs(), { "tab-b": { state: "idle", pid: null, app: "codex" } });
  projects = [];
  activity.sync();
  await made.idle();
  assert.deepEqual(activity.programs(), {}, "the last tab leaves, so no program state remains");
  wire.finish();
});
