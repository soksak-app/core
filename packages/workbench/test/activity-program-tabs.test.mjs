// The program state of each tab that shows an owned session is reported, for every tab of a card (docs/spec/program-state.md#status).
// Two tabs of one card whose plugin declares the program status each report their own state.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const imports = selectPageWire("exposure-none");
const { createRegistry } = await import("../exposure.js");
const { createActivity } = await import("../activity.js");
imports.finish();

const PROGRAM = { name: "probe.program", description: "The program state of the probe.", schema: { type: ["object", "null"] } };
const windowOf = (tabs) => [{ id: "p1", spaces: [{ id: "s1", layout: { state: { root: { card: "card-1", data: { tabs } } } } }] }];

test("two tabs of one card that show owned sessions each report their own program state", { timeout: 5000 }, async () => {
  const wire = selectPageWire("activity-program-tabs");
  const made = createRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("probe", { status: [PROGRAM] });
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.program" });
  const projects = windowOf([{ id: "tab-a", plugin: "probe" }, { id: "tab-b", plugin: "probe" }]);
  const activity = createActivity({
    observe: (name, surface, fn) => made.observe(name, surface, fn, { exact: true }),
    statuses: () => [],
    programStatus: (plugin) => (plugin === "probe" ? PROGRAM.name : null),
    projects: () => projects,
    changed: () => {},
    failed: () => {},
    programFailed: () => {},
    publish: () => {},
  });
  activity.sync();
  await made.idle();
  // tab-b registers its program status after the sync, as a tab that opens after the layout was presented does.
  made.registered({ surface: "tab-b", kind: "status", name: "probe.program" });
  await made.idle();
  const idle = (pid) => ({ state: "idle", pid, app: "claude-code" });
  made.changed({ surface: "tab-a", name: "probe.program", value: idle(101), version: 1 });
  made.changed({ surface: "tab-b", name: "probe.program", value: idle(202), version: 1 });
  await made.idle();
  assert.deepEqual(activity.programs(), { "tab-a": idle(101), "tab-b": idle(202) });
  wire.finish();
});
