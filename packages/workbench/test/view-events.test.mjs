// Checks the page side of the view event subscriptions (docs/spec/native-surfaces.md#view-surfaces). The subscriptions of a view
// are made of the parts that the surface modules give them: the native listeners and the sidecar of the surface runtime, the
// text size, the settings, the project data, the log gate, the run state and the exposure registry of the page. The host calls of
// each test are answered by its page-wire case (docs/spec/cases/page-wire/README.md), and the case delivers each event of the view
// as a notice. A test selects its case before it makes the surface runtime, because host.js reads the host when it is imported.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.matchMedia = dom.window.matchMedia;

const imports = selectPageWire("view-events-none");
const { surfaceContextRuntime } = await import("../host.js");
const { createViewSubscriptions } = await import("../view-events.js");
const { createRegistry } = await import("../exposure.js");
const { onRunEnd, onRunStart, runActive, setRunActive } = await import("../run-state.js");
const { notifyTextSize, onTextSize, setSurfaceTextSize, surfaceTextSize } = await import("../text-size.js");
const { beginSettings, onSettingsChange, pluginSettings, setPluginSettings } = await import("../settings.js");
const { compareProjectData, onDataChange } = await import("../plugin-data.js");
const { logGate } = await import("../log-gate.js");
const { hideSectionSurface, showSectionSurface } = await import("../section-surfaces.js");
const { surfaceLeftOut } = await import("../surface-modules.js");
imports.finish();

const GENERATION = 1;
const SURFACE = "probe-surface";
const SECTION = "spc-aaaaaa/left/probe.tree";
const declarations = { status: [], commands: [], element: [] };

let wire = null;

/** The events that the page pushed to the view through the host call viewEvent, in order. */
const pushed = () => wire.calls.filter(({ name }) => name === "viewEvent").map(({ payload }) => ({ event: payload.event, data: payload.data }));

/**
 * The subscriptions of the view surface over the case of the name, made as the surface modules make them: the registrars are those of
 * the surface runtime of the surface, and each event goes to the view through the host call viewEvent. more(runtime) gives the other
 * parts of the subscriptions. The returned failures hold the text of each push that the host refused, and canceled the events that were
 * canceled.
 */
function open(slug, more = () => ({}), surfaceId = SURFACE) {
  wire = selectPageWire(`view-events-${slug}`);
  const surface = { surfaceId, pluginId: "probe", sidecars: ["fixture-sidecar"] };
  const runtime = surfaceContextRuntime(surface, declarations);
  const failures = [];
  const canceled = [];
  const subscriptions = createViewSubscriptions({
    native: (name, listener) => runtime.native.on(name, listener),
    sidecar: {
      // The host posts each message of the session to the view; the route names the source generation of the view document.
      route: (id, name) => {
        const set = (on) => runtime.native.call("viewSidecarRoute", { generation: GENERATION, sidecar: name, id, on });
        return set(true).then(() => () => set(false));
      },
      onFailure: (id, listener) => runtime.sidecar().onFailure(id, listener),
    },
    push: (event, data) => runtime.native.call("viewEvent", { generation: GENERATION, event, data }),
    report: (text) => failures.push(text),
    cancel: (event) => canceled.push(event),
    ...more(runtime),
  });
  return { subs: subscriptions, failures, canceled };
}

/** The stored levels of the log gate as the gate keeps them after set. */
const levels = (frame) => ({ lifecycle: "error", input: "error", call: "error", io: "error", frame });

// The registrar of the text size, as the surface modules give it: the scale of the surface is read again at each notification.
const textSizeOf = (listener) => Promise.resolve(onTextSize(() => listener(surfaceTextSize(SURFACE))));

const runOf = { active: () => runActive(), onStart: (fn) => onRunStart(fn), onEnd: (fn) => onRunEnd(fn) };

test("a later view event waits for the earlier event delivery", async () => {
  const { subs } = open("ordered-delivery");
  await subs.native("input");
  wire.deliverNotice();
  wire.deliverNotice();
  await drained();
  const started = () => wire.calls.filter(({ name }) => name === "viewEvent").map(({ payload }) => payload.data.id);
  assert.deepEqual(started(), [1], "the second delivery must remain queued while the first is pending");
  wire.release();
  await subs.idle();
  assert.deepEqual(started(), [1, 2]);
  assert.deepEqual(pushed().map(({ data }) => data.id), [1, 2]);
  await subs.close();
  assert.deepEqual(wire.unsubscribed, ["input"]);
  wire.finish();
});

test("a native subscription is registered once and pushes each event of its name with its data", async () => {
  const { subs } = open("native-once");
  const first = subs.native("probe.changed");
  await first;
  assert.equal(await subs.native("probe.changed"), null);
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "probe.changed", data: { surface: "probe-surface", count: 1 } }]);
  await subs.close();
  wire.finish();
});

test("a log levels subscription pushes each change of the stored levels once and nothing while they stay", async () => {
  logGate.set(levels("error"));
  const { subs } = open("log-levels", () => ({
    logLevels: { read: () => logGate.classes(), on: (listener) => Promise.resolve(logGate.onChange(listener)) },
  }));
  assert.equal(typeof subs.logLevels, "function", "the subscriptions have no logLevels");
  assert.equal(await subs.logLevels(), null);
  assert.equal(await subs.logLevels(), null);
  logGate.set(levels("error"));
  logGate.set(levels("debug"));
  logGate.set(levels("debug"));
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "log.levels", data: levels("debug") }]);
  await subs.close();
  logGate.set(levels("error"));
  assert.deepEqual(pushed().length, 1, "the close ends the subscription");
  wire.finish();
});

test("a sidecar message subscription adds the host route of the view once, a restart removes it, and a failure is pushed", async () => {
  const { subs } = open("sidecar-route");
  await subs.sidecarMessage("probe-surface", "fixture-sidecar");
  assert.equal(await subs.sidecarMessage("probe-surface", "fixture-sidecar"), null);
  await subs.sidecarFailure("probe-surface");
  const routes = () => wire.calls.filter(({ name }) => name === "viewSidecarRoute")
    .map(({ payload }) => `${payload.on ? "on" : "off"} ${payload.sidecar} ${payload.id}`);
  assert.deepEqual(routes(), ["on fixture-sidecar probe-surface"], "the host posts the messages, so the page adds one route and pushes none");
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "sidecar.failure", data: { id: "probe-surface", reason: "exited" } }]);
  await subs.restart();
  assert.deepEqual(routes(), ["on fixture-sidecar probe-surface", "off fixture-sidecar probe-surface"], "a restart removes the route");
  wire.finish();
});

test("an event for a view whose surface is left out is canceled without a push, and pushes resume when it is drawn again", async () => {
  // A section surface whose section left the drawing exists until the commit releases it (docs/spec/plugins.md#sections).
  hideSectionSurface(SECTION);
  const { subs, canceled } = open("left-out", () => ({ leftOut: () => surfaceLeftOut(SECTION) }), SECTION);
  await subs.native("probe.event");
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(pushed(), [], "a left-out view received an event");
  assert.deepEqual(canceled, ["probe.event"]);
  showSectionSurface(SECTION);
  try {
    wire.deliverNotice();
    await subs.idle();
    assert.deepEqual(pushed(), [{ event: "probe.event", data: { surface: SECTION, n: 2 } }]);
  } finally {
    hideSectionSurface(SECTION);
  }
  await subs.close();
  wire.finish();
});

test("a push that the host refuses is reported with its text", async () => {
  const { subs, failures } = open("push-refused");
  await subs.native("probe.changed");
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(failures, ["view event probe.changed: probe-surface has no ready document"]);
  await subs.close();
  wire.finish();
});

test("a text size subscription is registered once and pushes each change of the scale", async () => {
  setSurfaceTextSize(() => 1);
  const { subs } = open("text-size", () => ({ textSize: textSizeOf }));
  const first = subs.textSize();
  const second = subs.textSize();
  assert.equal(await first, null);
  assert.equal(await second, null);
  setSurfaceTextSize(() => 1.5);
  notifyTextSize();
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "textSize", data: 1.5 }]);
  await subs.close();
  wire.finish();
});

test("a settings subscription is registered once and pushes each change of the settings", async () => {
  setPluginSettings([{ id: "probe", settings: { home: { label: "홈 주소", type: "address", default: "https://example.test/" } } }]);
  const { subs } = open("settings", () => ({
    settings: (listener) => Promise.resolve(onSettingsChange(() => listener(pluginSettings("probe")))),
  }));
  assert.equal(await subs.settings(), null);
  beginSettings({ common: { "probe.home": "" }, projects: [] }, null);
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "settings", data: { home: "" } }]);
  await subs.close();
  wire.finish();
});

test("a data subscription is registered once and pushes the key of each change of the project data", async () => {
  const { subs } = open("data", () => ({
    data: (listener) => Promise.resolve(onDataChange((project, plugin, key) => { if (plugin === "probe") listener(key); })),
  }));
  assert.equal(await subs.data(), null);
  assert.equal(await subs.data(), null);
  compareProjectData([{ id: "p1", plugins: { probe: { marks: 1 } } }], [{ id: "p1", plugins: { probe: { marks: 2 } } }]);
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "data", data: { key: "marks" } }]);
  await subs.close();
  compareProjectData([{ id: "p1", plugins: { probe: { marks: 2 } } }], [{ id: "p1", plugins: { probe: { marks: 3 } } }]);
  await subs.idle();
  assert.equal(pushed().length, 1, "the close ends the subscription of the data");
  wire.finish();
});

test("closing the surface ends every subscription, and an event after it is pushed to nothing", async () => {
  const { subs } = open("close");
  await subs.native("probe.changed");
  await subs.close();
  assert.deepEqual(wire.unsubscribed, ["probe.changed"], "the close removed the listener, so the host delivers no event to the subscription");
  await subs.idle();
  assert.deepEqual(pushed(), []);
  wire.finish();
});

/** A registry of the page with the core statuses core.grid and core.count that read and follow their values, as the core of the page registers them. */
function gridRegistry() {
  const made = createRegistry();
  made.declare("core", { status: [{ name: "core.grid", description: "Grid.", schema: {} }, { name: "core.count", description: "Count.", schema: {} }] });
  const grid = { value: { tabs: 2 }, emit: null };
  const count = { value: 1, emit: null };
  for (const [name, held] of [["core.grid", grid], ["core.count", count]]) {
    made.status(name, () => held.value, (listener) => { held.emit = listener; return () => { held.emit = null; }; });
  }
  return { made, grid, count };
}

/** The status events among the pushed events. */
const statuses = () => pushed().filter(({ event }) => event === "status");

test("a status watch pushes each value of its name as the status event and ends at unwatch", async () => {
  const { made, grid, count } = gridRegistry();
  const { subs } = open("status-core", () => ({ status: (name, surface, listener) => made.observe(name, surface, (value) => listener(value)) }));
  assert.equal(await subs.statusWatch("core.grid"), null);
  assert.equal(await subs.statusWatch("core.grid"), null, "a second watch of the same name registers nothing");
  await subs.idle();
  grid.emit({ tabs: 3 });
  await subs.idle();
  assert.deepEqual(pushed(), [
    { event: "status", data: { name: "core.grid", value: { tabs: 2 } } },
    { event: "status", data: { name: "core.grid", value: { tabs: 3 } } },
  ]);
  assert.equal(await subs.statusUnwatch("core.grid"), null);
  assert.equal(grid.emit, null, "the unwatch ends the watch of the name");
  assert.equal(await subs.statusUnwatch("core.grid"), null, "an unwatch of a name that is not watched ends nothing");
  await subs.statusWatch("core.count");
  assert.notEqual(count.emit, null);
  await subs.close();
  assert.equal(count.emit, null, "the close ends the status watches that remain");
  wire.finish();
});

test("a status watch with a surface follows the status on that surface, keyed by name and surface", async () => {
  const { subs } = open("status-surface", () => ({
    status: (name, surface, listener) => made.observe(name, surface, (value) => listener(value), { exact: surface !== undefined }),
  }));
  const made = createRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("probe", { status: [{ name: "probe.lines", description: "Lines.", schema: { type: "array" } }] });
  made.configure({ surfacePlugin: () => "probe" });
  for (const surface of ["spc-aaaaaa/left/files.tree", "tab-a"]) made.registered({ surface, kind: "status", name: "probe.lines" });
  assert.equal(await subs.statusWatch("probe.lines", "spc-aaaaaa/left/files.tree"), null);
  assert.equal(await subs.statusWatch("probe.lines", "tab-a"), null);
  assert.equal(await subs.statusWatch("probe.lines", "tab-a"), null, "a second watch of the same name and surface registers nothing");
  await made.idle();
  const forwarded = (method) => wire.calls.filter(({ name, payload }) => name === "exposureForward" && payload.method === method).map(({ payload }) => payload.surface);
  assert.deepEqual(forwarded("status.watch"), ["spc-aaaaaa/left/files.tree", "tab-a"]);
  made.changed({ surface: "spc-aaaaaa/left/files.tree", name: "probe.lines", value: ["section"], version: 1 });
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["tab"], version: 1 });
  await subs.idle();
  assert.deepEqual(pushed(), [
    { event: "status", data: { name: "probe.lines", surface: "spc-aaaaaa/left/files.tree", value: ["section"] } },
    { event: "status", data: { name: "probe.lines", surface: "tab-a", value: ["tab"] } },
  ]);
  assert.equal(await subs.statusUnwatch("probe.lines", "spc-aaaaaa/left/files.tree"), null);
  await made.idle();
  assert.deepEqual(forwarded("status.unwatch"), ["spc-aaaaaa/left/files.tree"], "an unwatch ends only the watch of its surface");
  await subs.close();
  await made.idle();
  assert.deepEqual(forwarded("status.unwatch"), ["spc-aaaaaa/left/files.tree", "tab-a"]);
  wire.finish();
});

test("a status watch that the page refuses registers nothing and rejects with the refusal", async () => {
  const { made } = gridRegistry();
  // The registry refuses the registration of a status that no declaration holds.
  const { subs } = open("status-refused", () => ({ status: (name) => made.status(name, () => 0, () => () => {}) }));
  await assert.rejects(subs.statusWatch("probe.count"), /status probe\.count is not declared/);
  wire.finish();
});

test("a subscription whose registrar returns the off function itself is refused and registers nothing", async () => {
  let registered = 0;
  // A registrar returns a promise of its off function, the one form that the view subscriptions accept (docs/spec/native-surfaces.md).
  const { subs } = open("registrar-function", () => ({ textSize: (listener) => { registered += 1; return onTextSize(() => listener(1)); } }));
  await assert.rejects(subs.textSize(), /view subscription textSize: the registrar returned function, want a promise of the off function/);
  assert.equal(registered, 1, "the registrar was called once");
  await subs.close();
  wire.finish();
});

test("a subscription whose registrar throws is refused with its error and registers nothing", async () => {
  const { subs } = open("registrar-throws", () => ({ textSize: () => onSettingsChange(null) }));
  await assert.rejects(subs.textSize(), /settings listener must be a function/);
  await subs.close();
  wire.finish();
});

test("a status watch holds the values of a run and delivers the newest at its end", async () => {
  const { made, grid } = gridRegistry();
  grid.value = { w: 1 };
  setRunActive(true);
  const { subs, failures, canceled } = open("status-run", () => ({
    status: (name, surface, listener) => made.observe(name, surface, (value) => listener(value)),
    run: runOf,
  }));
  await subs.statusWatch("core.grid");
  await subs.idle();
  assert.deepEqual(statuses().map(({ data }) => data.value), [{ w: 1 }], "the first value of a watch waited for the end of a run");
  grid.emit({ w: 2 });
  grid.emit({ w: 3 });
  await subs.idle();
  assert.equal(statuses().length, 1, "a value of a run was delivered during the run");
  assert.deepEqual(canceled, ["status"], "a value that a newer value replaced has no record");
  setRunActive(false);
  await subs.idle();
  assert.deepEqual(statuses().map(({ data }) => data.value), [{ w: 1 }, { w: 3 }], "the newest value was not delivered at the end of the run");
  grid.emit({ w: 4 });
  await subs.idle();
  assert.deepEqual(statuses().at(-1).data.value, { w: 4 }, "a value after the run was not delivered at once");

  setRunActive(true);
  grid.emit({ w: 5 });
  await subs.statusUnwatch("core.grid");
  setRunActive(false);
  await subs.idle();
  assert.deepEqual(statuses().at(-1).data.value, { w: 4 }, "a held value was delivered after its unwatch");
  assert.deepEqual(failures, []);
  await subs.close();
  wire.finish();
});

test("each start of a run is pushed to the view as the event run-start, and a closed view receives no more", async () => {
  setRunActive(false);
  const { subs, failures } = open("run-start", () => ({ run: runOf }));
  setRunActive(true);
  await subs.idle();
  assert.deepEqual(pushed().map(({ event, data }) => [event, data]), [["run-start", {}]]);
  await subs.close();
  setRunActive(false);
  setRunActive(true);
  await subs.idle();
  assert.equal(pushed().length, 1, "the listener of the start of a run ends with the subscriptions");
  setRunActive(false);
  assert.deepEqual(failures, []);
  wire.finish();
});
