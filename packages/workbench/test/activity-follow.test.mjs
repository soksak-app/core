// The page follows each status that declares activity on the surface of each tab of its window by a watch of that surface, derives
// the activities at each delivered value (docs/spec/activity.md#activity-of-a-tab) and publishes the activities of the spaces of each
// project of the window after each change of them (docs/spec/activity.md#activity-of-a-project). The host calls are answered by a page-wire case
// (docs/spec/cases/page-wire/README.md).
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

const STATE = { name: "probe.state", description: "The activity of the probe.", schema: { type: ["string", "null"] }, activity: true };

/** The window of one project whose one space holds the tabs in one card, in the stored form. */
const windowOf = (tabs) => [{ id: "p1", spaces: [{ id: "s1", layout: { state: { root: { card: "card-1", data: { tabs } } } } }] }];

test("the activity of a tab follows the watch of its surface, which starts when the surface registers and ends when the tab leaves", { timeout: 5000 }, async () => {
  const wire = selectPageWire("activity-follow-watches");
  const made = createRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("probe", { status: [STATE] });
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.state" });
  let projects = windowOf([{ id: "tab-a", plugin: "probe" }, { id: "tab-b", plugin: "probe" }]);
  let changes = 0;
  const errors = [];
  const published = [];
  const activity = createActivity({
    observe: (name, surface, fn) => made.observe(name, surface, fn, { exact: true }),
    statuses: (plugin) => (plugin === "probe" ? [STATE.name] : []),
    projects: () => projects,
    changed: () => { changes += 1; },
    failed: (tab, text) => errors.push([tab, text]),
    publish: (id, spaces) => published.push([id, spaces]),
  });
  activity.sync();
  await made.idle();
  assert.deepEqual(activity.state(), { spaces: {}, tabs: {} }, "no surface sent a value");
  assert.deepEqual(published, [], "a project without an activity that was never published is not published");
  made.changed({ surface: "tab-a", name: "probe.state", value: "running", version: 1 });
  assert.deepEqual(activity.state().tabs, { "tab-a": "running" });
  const running = { s1: { activity: "running", cards: { "card-1": "running" }, groups: {} } };
  assert.deepEqual(published, [["p1", running]]);
  // tab-b registers its status after the sync; the registration starts its watch, and its value raises the project to attention.
  made.registered({ surface: "tab-b", kind: "status", name: "probe.state" });
  await made.idle();
  made.changed({ surface: "tab-b", name: "probe.state", value: "attention", version: 1 });
  const attention = { s1: { activity: "attention", cards: { "card-1": "attention" }, groups: {} } };
  assert.deepEqual(activity.state(), { spaces: { p1: attention }, tabs: { "tab-a": "running", "tab-b": "attention" } });
  assert.deepEqual(published, [["p1", running], ["p1", attention]], "the window derives no activity of the project, only of its spaces");
  // A value that is no activity gives tab-a none and shows its error until a valid value withdraws it.
  made.changed({ surface: "tab-a", name: "probe.state", value: "busy", version: 2 });
  assert.deepEqual(activity.state().tabs, { "tab-b": "attention" });
  assert.deepEqual(errors, [["tab-a", 'probe exposes probe.state on tab tab-a: activity value "busy" is not one of attention, failed, running, idle']]);
  made.changed({ surface: "tab-a", name: "probe.state", value: null, version: 3 });
  assert.deepEqual(activity.state().tabs, { "tab-b": "attention" });
  assert.deepEqual(errors.at(-1), ["tab-a", null]);
  // tab-a leaves the layouts, so its watch ends.
  projects = windowOf([{ id: "tab-b", plugin: "probe" }]);
  activity.sync();
  await made.idle();
  assert.deepEqual(activity.state().tabs, { "tab-b": "attention" });
  assert.equal(changes, 3, "each change of core.activity is announced once, and the leave of a tab without an activity changes nothing");
  assert.equal(published.length, 2, "an unchanged project is not published again");
  // tab-b ends with a null value, so the project has no activity and is withdrawn with empty spaces.
  made.changed({ surface: "tab-b", name: "probe.state", value: null, version: 2 });
  assert.deepEqual(published.at(-1), ["p1", {}]);
  // A project that leaves the window is not published: the host removes its entry with the release.
  made.changed({ surface: "tab-b", name: "probe.state", value: "failed", version: 3 });
  assert.equal(published.length, 4);
  projects = [];
  activity.sync();
  assert.equal(published.length, 4, "a project that left the window is not published");
  wire.finish();
});
