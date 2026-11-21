// Checks the page side of the view event subscriptions (docs/spec/native-surfaces.md#view-surfaces). The subscriptions of a view
// are made of the parts that the surface modules give them: the native listeners and the sidecar of the surface runtime, the
// text size, the settings, the project data, the log gate, the run state and the exposure registry of the page. The host calls of
// each test are answered by its page-wire case (docs/spec/cases/page-wire/README.md). The case delivers each request of the view as a
// view-call notice, which the test answers with the subscription that the command names, and it records each change of the window as a
// change step, which the test applies to the source that the page reads. A test selects its case before it makes the surface runtime,
// because host.js reads the host when it is imported.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { pageIdentity } from "../page-identity.js";
import { drained } from "./support/drained.mjs";

const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// The page reads the language of its document, not the locale of the machine that runs the test.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.matchMedia = dom.window.matchMedia;

const imports = selectPageWire("view-events-none");
const { surfaceContextRuntime } = await import("../host.js");
const { createViewSubscriptions } = await import("@soksak/plugin-api/view-events");
const { createRegistry } = await import("../exposure.js");
const { onRunEnd, onRunStart, runActive, setRunActive } = await import("../run-state.js");
const { notifyTextSize, onTextSize, setSurfaceTextSize, surfaceTextSize } = await import("../text-size.js");
const { beginSettings, onSettingsChange, pluginSettings, setPluginSettings } = await import("../settings.js");
const { compareProjectData, onDataChange } = await import("../plugin-data.js");
const { logGate } = await import("../log-gate.js");
const { hideSectionSurface, showSectionSurface } = await import("../section-surfaces.js");
const { surfaceLeftOut } = await import("../surface-modules.js");
const { pluginNativeGate } = await import("@soksak/plugin-api/view-answer");
imports.finish();

const GENERATION = 1;
const SURFACE = "probe-surface";
const SECTION = "spc-aaaaaa/left/probe.tree";
const declarations = { status: [], commands: [], element: [] };

let wire = null;
// The view-call requests that the page received, in order. The listener is registered by the first view call of a case.
let requests = null;

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
  requests = null;
  const surface = { surfaceId, pluginId: "probe", sidecars: ["fixture-sidecar"] };
  const runtime = surfaceContextRuntime(surface, declarations);
  // The plugin-facing handle of the view, as surface-modules.js makes it: the gate refuses the events that a view may not subscribe.
  const gate = pluginNativeGate(runtime.native);
  const failures = [];
  const canceled = [];
  const subscriptions = createViewSubscriptions({
    native: (name, listener) => gate.on(name, listener),
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

/** Plays the next change step of the case, which must name the state of the window that the test sets. */
const playChange = (state) => {
  const change = wire.change();
  assert.equal(change.state, state, "the case records another change of the window");
  return change;
};

/**
 * Plays the view-call notice of the next step: the notice reaches the listener of the page, the subscription that run starts answers
 * with its result, and the view replies to the host with that result as the call viewReply. command is the command that the notice names.
 */
async function viewCall(subs, command, run) {
  if (requests === null) {
    requests = [];
    host.on("view-call", (request) => requests.push(request));
  }
  wire.deliverNotice();
  const request = requests.at(-1);
  assert.equal(request.command, command, "the case asks for another command of the view");
  const result = await run();
  await subs.idle();
  await host.call("viewReply", { id: request.id, result, page: pageIdentity, generation: request.generation, surface: request.surface });
  return result;
}

/** The stored levels of the log gate as the gate keeps them after set. */
const levels = (frame) => ({ lifecycle: "error", input: "error", call: "error", io: "error", frame });

// The registrar of the text size, as the surface modules give it: the scale of the surface is read again at each notification.
const textSizeOf = (listener) => Promise.resolve(onTextSize(() => listener(surfaceTextSize(SURFACE))));

const runOf = { active: () => runActive(), onStart: (fn) => onRunStart(fn), onEnd: (fn) => onRunEnd(fn) };

test("a later view event waits for the earlier event delivery", async () => {
  const { subs } = open("ordered-delivery");
  await subs.native("image-event");
  wire.deliverNotice();
  wire.deliverNotice();
  await drained();
  const started = () => wire.calls.filter(({ name }) => name === "viewEvent").map(({ payload }) => payload.data.event);
  assert.deepEqual(started(), ["press"], "the second delivery must remain queued while the first is pending");
  wire.release();
  await subs.idle();
  assert.deepEqual(started(), ["press", "release"]);
  assert.deepEqual(pushed().map(({ data }) => data.event), ["press", "release"]);
  await subs.close();
  assert.deepEqual(wire.unsubscribed, ["image-event"]);
  wire.finish();
});

test("a native subscription is registered once and pushes each event of its name with its data", async () => {
  const { subs } = open("native-once");
  const first = subs.native("exposure-request");
  await first;
  assert.equal(await subs.native("exposure-request"), null);
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "exposure-request", data: { surface: "probe-surface", count: 1 } }]);
  await subs.close();
  wire.finish();
});

test("a log levels subscription pushes each change of the stored levels once and nothing while they stay", async () => {
  logGate.set(levels("error"));
  const { subs } = open("log-levels", () => ({
    logLevels: { read: () => logGate.classes(), on: (listener) => Promise.resolve(logGate.onChange(listener)) },
  }));
  assert.equal(typeof subs.logLevels, "function", "the subscriptions have no logLevels");
  assert.equal(await viewCall(subs, "runtime.log.levels.on", () => subs.logLevels()), null);
  assert.equal(await viewCall(subs, "runtime.log.levels.on", () => subs.logLevels()), null, "a second subscription did not reply null");
  // The stored levels that the case records, applied through the log gate of the page: the levels that stay the same push nothing
  const same = playChange("logLevels");
  logGate.set(same.value);
  await subs.idle();
  assert.deepEqual(pushed(), [], "the levels that stayed the same pushed an event");
  const change = playChange("logLevels");
  logGate.set(change.value);
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "log.levels", data: change.value }]);
  const again = playChange("logLevels");
  logGate.set(again.value);
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "log.levels", data: change.value }], "the same levels a second time pushed an event");
  wire.close();
  await subs.close();
  // The change after the close is a step of the case: the closed view pushes nothing for it
  const after = playChange("logLevels");
  logGate.set(after.value);
  await subs.idle();
  assert.deepEqual(pushed().length, 1, "the close ends the subscription");
  wire.finish();
});

test("a document stream message of a region is pushed to the view with its data", async () => {
  const { subs } = open("document-stream");
  await subs.native("document-stream");
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "document-stream", data: { surface: "probe-surface", document: "doc", handle: 3, message: { n: 1 } } }]);
  await subs.close();
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
  const { subs, canceled } = open("left-out", () => ({ leftOut: () => surfaceLeftOut(SECTION) }), SECTION);
  await subs.native("exposure-request");
  // The section leaves the drawing, as the case records before its first notice
  const left = playChange("leftOut");
  assert.equal(left.value, true);
  hideSectionSurface(SECTION);
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(pushed(), [], "a left-out view received an event");
  assert.deepEqual(canceled, ["exposure-request"]);
  // The section is drawn again, as the case records before its second notice
  const drawn = playChange("leftOut");
  assert.equal(drawn.value, false);
  showSectionSurface(SECTION);
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "exposure-request", data: { surface: SECTION, n: 2 } }]);
  await subs.close();
  wire.finish();
});

test("a push that the host refuses is reported with its text", async () => {
  const { subs, failures } = open("push-refused");
  await subs.native("exposure-request");
  wire.deliverNotice();
  await subs.idle();
  assert.deepEqual(failures, ["view event exposure-request: probe-surface has no ready document"]);
  await subs.close();
  wire.finish();
});

test("a text size subscription is registered once and pushes each change of the scale", async () => {
  setSurfaceTextSize(() => 1);
  const { subs } = open("text-size", () => ({ textSize: textSizeOf }));
  assert.equal(await viewCall(subs, "runtime.textSize.on", () => subs.textSize()), null);
  assert.equal(await viewCall(subs, "runtime.textSize.on", () => subs.textSize()), null, "a second subscription did not reply null");
  // The scale that the case records, applied through the scale of the surface
  const change = playChange("textSize");
  setSurfaceTextSize(() => change.value);
  notifyTextSize();
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "textSize", data: change.value }]);
  await subs.close();
  wire.finish();
});

test("a settings subscription is registered once and pushes each change of the settings", async () => {
  setPluginSettings([{ id: "probe", settings: { home: { label: "홈 주소", type: "address", default: "https://example.test/" } } }]);
  const { subs } = open("settings", () => ({
    settings: (listener) => Promise.resolve(onSettingsChange(() => listener(pluginSettings("probe")))),
  }));
  assert.equal(await viewCall(subs, "runtime.settings.on", () => subs.settings()), null);
  // The setting that the case records, applied through the settings of the plugin
  const change = playChange("settings");
  beginSettings({ common: { "probe.home": change.value.home }, projects: [] }, null);
  await drained();
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "settings", data: change.value }]);
  await subs.close();
  wire.finish();
});

test("a data subscription is registered once and pushes the key of each change of the project data", async () => {
  const { subs } = open("data", () => ({
    data: (listener) => Promise.resolve(onDataChange((project, plugin, key) => { if (plugin === "probe") listener(key); })),
  }));
  assert.equal(await viewCall(subs, "runtime.data.on", () => subs.data()), null);
  assert.equal(await viewCall(subs, "runtime.data.on", () => subs.data()), null, "a second subscription did not reply null");
  // The project data that the case records: the key takes its value, applied through the project data of the start project
  const change = playChange("data");
  compareProjectData([{ id: "p1", plugins: { probe: { [change.key]: 1 } } }], [{ id: "p1", plugins: { probe: { [change.key]: change.value } } }]);
  await subs.idle();
  assert.deepEqual(pushed(), [{ event: "data", data: { key: "marks" } }]);
  wire.close();
  await subs.close();
  // The change after the close is a step of the case: the closed view pushes nothing for it
  const after = playChange("data");
  compareProjectData([{ id: "p1", plugins: { probe: { [after.key]: 2 } } }], [{ id: "p1", plugins: { probe: { [after.key]: after.value } } }]);
  await subs.idle();
  assert.equal(pushed().length, 1, "the close ends the subscription of the data");
  wire.finish();
});

test("closing the surface ends every subscription, and an event after it is pushed to nothing", async () => {
  const { subs } = open("close");
  await subs.native("exposure-request");
  await subs.close();
  assert.deepEqual(wire.unsubscribed, ["exposure-request"], "the close removed the listener, so the host delivers no event to the subscription");
  await subs.idle();
  assert.deepEqual(pushed(), []);
  wire.finish();
});

/** A registry of the page with the core statuses core.grid and core.focus that read and follow their values, as the core of the page registers them. */
function gridRegistry() {
  const made = createRegistry();
  made.declare("core", { status: [{ name: "core.grid", description: "Grid.", schema: {} }, { name: "core.focus", description: "Focus.", schema: {} }] });
  const grid = { value: { tabs: 2 }, emit: null };
  const focus = { value: 1, emit: null };
  for (const [name, held] of [["core.grid", grid], ["core.focus", focus]]) {
    made.status(name, () => held.value, (listener) => { held.emit = listener; return () => { held.emit = null; }; });
  }
  return { made, grid, focus };
}

/** The status events among the pushed events. */
const statuses = () => pushed().filter(({ event }) => event === "status");

test("a status watch pushes each value of its name as the status event, and ends at unwatch and at close", async () => {
  const { made, grid, focus } = gridRegistry();
  const { subs } = open("status-core", () => ({ status: (name, surface, listener) => made.observe(name, surface, (value) => listener(value)) }));
  assert.equal(await viewCall(subs, "runtime.status.watch", () => subs.statusWatch("core.grid")), null);
  assert.equal(await viewCall(subs, "runtime.status.watch", () => subs.statusWatch("core.grid")), null, "a second watch of the same name registers nothing");
  // The value of core.grid that the case records, applied through the grid of the window
  const change = playChange("status");
  assert.equal(change.name, "core.grid");
  grid.value = change.value;
  grid.emit(change.value);
  await subs.idle();
  assert.equal(await viewCall(subs, "runtime.status.unwatch", () => subs.statusUnwatch("core.grid")), null);
  assert.equal(grid.emit, null, "the unwatch ends the watch of the name");
  // The value of core.grid after its unwatch: the case records the change, and the page pushes nothing for it
  const after = playChange("status");
  assert.equal(after.name, "core.grid");
  grid.value = after.value;
  assert.equal(await viewCall(subs, "runtime.status.unwatch", () => subs.statusUnwatch("core.grid")), null, "an unwatch of a name that is not watched ends nothing");
  assert.equal(await viewCall(subs, "runtime.status.watch", () => subs.statusWatch("core.focus")), null);
  assert.notEqual(focus.emit, null);
  assert.deepEqual(pushed(), [
    { event: "status", data: { name: "core.grid", value: { tabs: 2 } } },
    { event: "status", data: { name: "core.grid", value: { tabs: 3 } } },
    { event: "status", data: { name: "core.focus", value: 1 } },
  ]);
  wire.close();
  await subs.close();
  assert.equal(grid.emit, null);
  assert.equal(focus.emit, null, "the close ends the status watch that remains");
  // The change of core.focus after the close is a step of the case: the closed view pushes nothing for it
  const late = playChange("status");
  assert.equal(late.name, "core.focus");
  focus.value = late.value;
  await subs.idle();
  assert.equal(pushed().length, 3, "the closed view received a status value");
  wire.finish();
});

test("a status watch with a surface follows the status on that surface, keyed by name and surface", async () => {
  const SECTION_FILES = "spc-aaaaaa/left/files.tree";
  const TAB = "tab-a";
  const { subs } = open("status-surface", () => ({
    status: (name, surface, listener) => made.observe(name, surface, (value) => listener(value), { exact: surface !== undefined }),
  }));
  const made = createRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("probe", { status: [{ name: "probe.lines", description: "Lines.", schema: { type: "array" } }] });
  made.configure({ surfacePlugin: () => "probe" });
  for (const surface of [SECTION_FILES, TAB]) made.registered({ surface, kind: "status", name: "probe.lines" });
  // Each watch and unwatch of the view ends when the forwarded call to its surface is answered, so the view replies after it.
  const watch = async (surface) => {
    const result = await subs.statusWatch("probe.lines", surface);
    await made.idle();
    return result;
  };
  const unwatch = async (surface) => {
    const result = await subs.statusUnwatch("probe.lines", surface);
    await made.idle();
    return result;
  };
  const forwarded = (method) => wire.calls.filter(({ name, payload }) => name === "exposureForward" && payload.method === method).map(({ payload }) => payload.surface);
  assert.equal(await viewCall(subs, "runtime.status.watch", () => watch(SECTION_FILES)), null);
  assert.equal(await viewCall(subs, "runtime.status.watch", () => watch(TAB)), null);
  assert.equal(await viewCall(subs, "runtime.status.watch", () => watch(TAB)), null, "a second watch of the same name and surface registers nothing");
  assert.deepEqual(forwarded("status.watch"), [SECTION_FILES, TAB]);
  // The value that each surface reports, as the case records it: the registry delivers it to the subscription of the view
  const section = playChange("status");
  assert.equal(section.surface, SECTION_FILES);
  made.changed({ surface: section.surface, name: section.name, value: section.value, version: 1 });
  await subs.idle();
  const tab = playChange("status");
  assert.equal(tab.surface, TAB);
  made.changed({ surface: tab.surface, name: tab.name, value: tab.value, version: 1 });
  await subs.idle();
  assert.deepEqual(pushed(), [
    { event: "status", data: { name: "probe.lines", surface: SECTION_FILES, value: ["section"] } },
    { event: "status", data: { name: "probe.lines", surface: TAB, value: ["tab"] } },
  ]);
  assert.equal(await viewCall(subs, "runtime.status.unwatch", () => unwatch(SECTION_FILES)), null);
  assert.deepEqual(forwarded("status.unwatch"), [SECTION_FILES], "an unwatch ends only the watch of its surface");
  // The close ends the watch of the tab surface, which the view has not unwatched
  wire.close();
  await subs.close();
  await made.idle();
  assert.deepEqual(forwarded("status.unwatch"), [SECTION_FILES, TAB]);
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
  assert.equal(await viewCall(subs, "runtime.status.watch", () => subs.statusWatch("core.grid")), null);
  assert.deepEqual(statuses().map(({ data }) => data.value), [{ w: 1 }], "the first value of a watch was not delivered at once during a run");
  // The values of core.grid that the case records during the run: the second is replaced by the third, and neither is delivered
  const second = playChange("status");
  grid.value = second.value;
  grid.emit(second.value);
  const third = playChange("status");
  grid.value = third.value;
  grid.emit(third.value);
  await subs.idle();
  assert.equal(statuses().length, 1, "a value of a run was delivered during the run");
  // The cancel records the replaced value. It is neither a call nor a push, so no replay of the case observes it: only this test asserts it.
  assert.deepEqual(canceled, ["status"], "a value that a newer value replaced has no record");
  // The end of the run delivers the newest value
  assert.equal(playChange("run").value, false);
  setRunActive(false);
  await subs.idle();
  assert.deepEqual(statuses().map(({ data }) => data.value), [{ w: 1 }, { w: 3 }], "the newest value was not delivered at the end of the run");
  // A value after the run is delivered at once
  const fourth = playChange("status");
  grid.value = fourth.value;
  grid.emit(fourth.value);
  await subs.idle();
  assert.deepEqual(statuses().at(-1).data.value, { w: 4 }, "a value after the run was not delivered at once");
  // The start of the next run is pushed as the event run-start
  assert.equal(playChange("run").value, true);
  setRunActive(true);
  await subs.idle();
  assert.deepEqual(pushed().at(-1), { event: "run-start", data: {} });
  // A value during the run is held; its unwatch ends the watch before the run ends, so the held value is not delivered
  const held = playChange("status");
  grid.value = held.value;
  grid.emit(held.value);
  assert.equal(await viewCall(subs, "runtime.status.unwatch", () => subs.statusUnwatch("core.grid")), null);
  assert.equal(playChange("run").value, false);
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
  // The start of a run that the case records, applied through the run state of the window
  const change = playChange("run");
  assert.equal(change.value, true);
  setRunActive(change.value);
  await subs.idle();
  assert.deepEqual(pushed().map(({ event, data }) => [event, data]), [["run-start", {}]]);
  wire.close();
  await subs.close();
  // The run changes after the close are steps of the case: the closed view receives no run-start for them
  const ended = playChange("run");
  assert.equal(ended.value, false);
  setRunActive(ended.value);
  const restarted = playChange("run");
  assert.equal(restarted.value, true);
  setRunActive(restarted.value);
  await subs.idle();
  assert.equal(pushed().length, 1, "the listener of the start of a run ends with the subscriptions");
  setRunActive(false);
  assert.deepEqual(failures, []);
  wire.finish();
});
