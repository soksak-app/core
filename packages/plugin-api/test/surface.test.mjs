import assert from "node:assert/strict";
import test from "node:test";
import { createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "../surface.js";

const TAB = { title() {}, footer() {}, directory() {}, notify() {}, modified() {}, error() {}, keep() {} };
const ICON = (name) => `<svg data-icon="${name}"></svg>`;
const CLOSING = new AbortController().signal;
const ORIGIN = { directory: null };

test("surface modules mount into the supplied root and dispose exactly once", async () => {
  const root = { children: [], appendChild(node) { this.children.push(node); } };
  const phases = [];
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    exposure: { command() {} },
    sidecar() {}, command() {}, emit() {}, native: {},
  } });
  context.status.subscribe(({ phase }) => phases.push(phase));
  let disposed = 0;
  const mounted = await mountSurfaceModule({
    mount(target, received) {
      assert.equal(target, root);
      assert.equal(received.surfaceId, "tab-1");
      received.status.report("ready");
      return { dispose() { disposed++; } };
    },
  }, root, context);
  assert.deepEqual(phases, []);
  releaseSurfaceReady(context);
  mounted.dispose();
  assert.deepEqual(phases, ["ready"]);
  assert.equal(disposed, 1);
});

test("surface context exposes only scoped runtime capabilities", () => {
  const root = { appendChild() {} };
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    sidecar: () => "port", command: () => "command", native: { composition: {} }, exposure: { command() {} }, emit() {},
    settings: { read: () => ({ "cursor.shape": "block" }), on: () => () => {} },
  } });
  assert.equal(context.runtime.sidecar(), "port");
  assert.deepEqual(context.runtime.native, { composition: {} });
  assert.equal(context.runtime.settings.read()["cursor.shape"], "block");
  assert.equal(context.runtime.command(), "command");
  assert.equal("call" in context.runtime, false);
});

test("surface context carries the tab reports and the origin directory", () => {
  const root = { appendChild() {} };
  const reported = [];
  const runtime = { exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {} };
  const context = createSurfaceContext({ closing: CLOSING, root, surfaceId: "tab-1", pluginId: "fixture", runtime, icon: ICON,
    tab: { title: (text) => reported.push(["title", text]), footer: (text) => reported.push(["footer", text]),
      directory: (path) => reported.push(["directory", path]), notify: (text) => reported.push(["notify", text]),
      modified: (value) => reported.push(["modified", value]), error: (text) => reported.push(["error", text]),
      keep: (reason, on) => reported.push(["keep", reason, on]) },
    origin: { directory: "/tmp/origin" } });
  context.tab.title("vim");
  context.tab.footer("/tmp");
  context.tab.directory("/tmp");
  context.tab.notify("done");
  context.tab.modified(true);
  context.tab.error("write failed");
  context.tab.keep("busy", true);
  assert.deepEqual(reported, [["title", "vim"], ["footer", "/tmp"], ["directory", "/tmp"], ["notify", "done"], ["modified", true], ["error", "write failed"], ["keep", "busy", true]]);
  assert.equal(context.tab.state, undefined, "a surface without surface.unload has no tab state");
  assert.equal(context.origin.directory, "/tmp/origin");
  assert.equal(Object.isFrozen(context.origin), true);
  assert.equal(createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-2", runtime, tab: TAB, icon: ICON }).origin.directory, null);
  assert.throws(() => createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-3", runtime, icon: ICON }),
    /surface context requires tab.title, tab.footer, tab.directory, tab.notify, tab.modified, tab.error, and tab.keep/);
  assert.throws(() => createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-4", runtime, icon: ICON, tab: { ...TAB, error: undefined } }),
    /surface context requires tab.title, tab.footer, tab.directory, tab.notify, tab.modified, tab.error, and tab.keep/);
});

test("surface context offers the core icons and requires them", () => {
  const root = { appendChild() {} };
  const runtime = { exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {} };
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", runtime, tab: TAB, icon: ICON });
  assert.equal(context.icon("rotate-cw"), '<svg data-icon="rotate-cw"></svg>');
  assert.throws(() => createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-2", runtime, tab: TAB }),
    /surface context requires icon\(name\)/);
});

test("surface context carries the window's project root or null", () => {
  const root = { appendChild() {} };
  const runtime = { exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {} };
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", runtime, tab: TAB, icon: ICON, project: { root: "/work/app" } });
  assert.deepEqual(context.project, { root: "/work/app" });
  assert.equal(Object.isFrozen(context.project), true);
  assert.equal(createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-2", runtime, tab: TAB, icon: ICON }).project, null);
});

test("releasing the ready state of an unknown context is an error", () => {
  assert.throws(() => releaseSurfaceReady({}), /createSurfaceContext/);
});

test("surface context gives the contributions of the plugin's declared extension points", () => {
  const root = { appendChild() {} };
  const runtime = { sidecar: () => "port", command: () => "command", exposure: { command() {} }, emit() {} };
  const plain = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime });
  assert.throws(() => plain.contributions("language"), /extension point language is not declared by fixture/);
  const items = [{ plugin: "tidy", item: { name: "tidy" }, module: "/modules/tidy/ui/tidy.js" }];
  const provider = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-2", pluginId: "fixture", tab: TAB, icon: ICON, runtime,
    contributions: (point) => (point === "language" ? items : []) });
  assert.equal(provider.contributions("language"), items);
  assert.throws(() => provider.contributions(""), /contributions requires an extension point name/);
});

test("surface context gives a copy of the tab parameters, or null for a tab without them", () => {
  const root = { appendChild() {} };
  const runtime = { sidecar: () => "port", command: () => "command", exposure: { command() {} }, emit() {} };
  const params = { path: "notes/todo.md" };
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", pluginId: "fixture", icon: ICON, runtime, tab: { ...TAB, params } });
  assert.deepEqual(context.tab.params, params);
  assert.notEqual(context.tab.params, params);
  assert.equal(Object.isFrozen(context.tab.params), true);
  const plain = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-2", pluginId: "fixture", icon: ICON, runtime, tab: TAB });
  assert.equal(plain.tab.params, null);
});

// A plugin writes its events to the performance trace through the surface context, named with its plugin and surface,
// so a defect of a surface is recorded with the events of the host and the sidecars (docs/spec/plugins.md).
test("surface context traces an event with the plugin and the surface", () => {
  const root = { appendChild() {} };
  const lines = [];
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {},
    trace: (event, fields) => lines.push([event, fields]), traceEnabled: () => true,
  } });
  context.runtime.trace("fixture.input", { key: "a" });
  assert.deepEqual(lines, [["fixture.input", { key: "a", plugin: "fixture", surface: "tab-1" }]]);
  assert.throws(() => context.runtime.trace("", {}), /trace requires an event name/);
  assert.throws(() => context.runtime.trace("fixture.input", null), /trace requires fields as an object/);
});

// A plugin writes an event of the event log through the surface context: the name of the event is `plugin.<plugin>.<event>`, the
// fields carry the surface, and a page without a host has no event log, as a log that is off (docs/spec/plugins.md#logging).
test("surface context logs an event of the plugin at each level with the surface in its fields", () => {
  const root = { appendChild() {} };
  const events = [];
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {},
    log: (level, event, fields) => events.push([level, event, fields]), logEnabled: () => true,
  } });
  for (const level of ["error", "warn", "info", "debug", "trace"]) context.runtime.log[level]("input.key", { key: "a" });
  context.runtime.log.info("started");
  assert.deepEqual(events.map(([level, event]) => [level, event]), [
    ["error", "plugin.fixture.input.key"], ["warn", "plugin.fixture.input.key"], ["info", "plugin.fixture.input.key"],
    ["debug", "plugin.fixture.input.key"], ["trace", "plugin.fixture.input.key"], ["info", "plugin.fixture.started"],
  ]);
  assert.deepEqual(events[0][2], { key: "a", surface: "tab-1" });
  assert.deepEqual(events.at(-1)[2], { surface: "tab-1" });
  for (const bad of ["", "Input", "input key", "input..key", ".input", 7]) {
    assert.throws(() => context.runtime.log.info(bad, {}), /log requires an event name/, String(bad));
  }
  assert.throws(() => context.runtime.log.info("input", null), /log requires fields as an object/);
  assert.throws(() => context.runtime.log.info("input", { surface: "other" }), /log fields must not name the surface/);
  const hostless = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-2", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {},
  } });
  hostless.runtime.log.error("input", {});
});

// A plugin joins a chain of the event log with `cids`, which the page writer requires in the form of the host (a non-empty string
// without a quote, a backslash or a control character), and builds the fields of an event only while its level is stored
// (docs/spec/plugins.md#logging).
function loggingContext(extra = {}) {
  const events = [];
  const traces = [];
  const gate = { log: new Set(["error", "warn", "info", "debug", "trace"]), trace: true };
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root: { appendChild() {} }, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {},
    log: (...args) => events.push(args), logEnabled: (level) => gate.log.has(level),
    trace: (event, fields) => traces.push([event, fields]), traceEnabled: () => gate.trace,
    ...extra,
  } });
  return { context, events, traces, gate };
}

test("a plugin event carries the cids of its chain to the page writer", () => {
  const { context, events } = loggingContext();
  context.runtime.log.info("input.key", { key: "a" }, { cids: ["p1.1", "p1.2"] });
  context.runtime.log.info("input.key", { key: "b" });
  context.runtime.log.info("input.key", { key: "c" }, { cids: [] });
  assert.deepEqual(events.map(([, , , cids]) => cids), [["p1.1", "p1.2"], undefined, undefined]);
  for (const bad of [[""], ['a"b'], ["a\\b"], ["a\nb"], ["a\u007fb"], [7], "p1.1", null]) {
    assert.throws(() => context.runtime.log.info("input.key", {}, { cids: bad }), /log cids must be an array of non-empty strings/, JSON.stringify(bad));
  }
  assert.throws(() => context.runtime.log.info("input.key", {}, { chain: ["p1.1"] }), /log options may only hold cids/);
  assert.throws(() => context.runtime.log.info("input.key", {}, null), /log options may only hold cids/);
  assert.equal(events.length, 3, "a refused call stores nothing");
});

test("a plugin asks whether a level is stored and builds the fields of an event only then", () => {
  const { context, events, gate } = loggingContext();
  assert.equal(context.runtime.log.enabled("debug"), true);
  gate.log.delete("debug");
  assert.equal(context.runtime.log.enabled("debug"), false);
  assert.throws(() => context.runtime.log.enabled("verbose"), /log level must be one of/);
  let built = 0;
  const fields = () => { built += 1; return { key: "a" }; };
  context.runtime.log.debug("input.key", fields);
  assert.equal(built, 0, "a closed level builds nothing");
  assert.equal(events.length, 0);
  context.runtime.log.info("input.key", fields, { cids: ["p1.1"] });
  assert.equal(built, 1);
  assert.deepEqual(events, [["info", "plugin.fixture.input.key", { key: "a", surface: "tab-1" }, ["p1.1"]]]);
  assert.throws(() => context.runtime.log.info("input.key", () => null), /log requires fields as an object/);
  assert.throws(() => context.runtime.log.info("input.key", () => ({ surface: "x" })), /log fields must not name the surface/);
  assert.throws(() => context.runtime.log.info("Bad", () => { built += 1; return {}; }), /log requires an event name/);
  assert.equal(built, 1, "an invalid name is refused before the builder runs");
  const hostless = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root: { appendChild() {} }, surfaceId: "tab-2", pluginId: "fixture", tab: TAB, icon: ICON, runtime: {
    exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {},
  } });
  assert.equal(hostless.runtime.log.enabled("error"), false);
  hostless.runtime.log.error("input", fields);
  assert.equal(built, 1, "a page without a host builds nothing");
});

test("a plugin trace builds its fields only while the trace is on", () => {
  const { context, traces, gate } = loggingContext();
  let built = 0;
  const fields = () => { built += 1; return { key: "a" }; };
  gate.trace = false;
  assert.equal(context.runtime.trace.enabled(), false);
  context.runtime.trace("fixture.input", fields);
  assert.equal(built, 0, "a trace that is off builds nothing");
  gate.trace = true;
  assert.equal(context.runtime.trace.enabled(), true);
  context.runtime.trace("fixture.input", fields);
  assert.deepEqual(traces, [["fixture.input", { key: "a", plugin: "fixture", surface: "tab-1" }]]);
  assert.throws(() => context.runtime.trace("fixture.input", () => null), /trace requires fields as an object/);
});

test("a runtime that stores events or traces without the query of its gate is refused", () => {
  const base = { exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {} };
  const make = (runtime) => () => createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root: { appendChild() {} }, surfaceId: "tab-1", pluginId: "fixture", tab: TAB, icon: ICON, runtime: { ...base, ...runtime } });
  assert.throws(make({ log() {} }), /runtime\.log requires runtime\.logEnabled/);
  assert.throws(make({ trace() {} }), /runtime\.trace requires runtime\.traceEnabled/);
  assert.throws(make({ logEnabled() {} }), /runtime\.logEnabled requires runtime\.log/);
});

test("a surface context requires the closing signal and exposes it", () => {
  const root = { appendChild() {} };
  const runtime = { exposure: { command() {} }, emit() {}, sidecar() {}, command() {} };
  assert.throws(() => createSurfaceContext({ origin: ORIGIN, root, surfaceId: "tab-1", runtime, tab: TAB, icon: ICON }),
    /requires the closing signal/);
  assert.equal(createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", runtime, tab: TAB, icon: ICON }).closing, CLOSING);
});

test("surface context carries the tab state of a surface that declares surface.unload", () => {
  const root = { appendChild() {} };
  const runtime = { exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {} };
  const written = [];
  const state = { read: () => ({ page: 2 }), write: (value) => written.push(value) };
  const context = createSurfaceContext({ origin: ORIGIN, closing: CLOSING, root, surfaceId: "tab-1", runtime, icon: ICON, tab: { ...TAB, state } });
  context.tab.state.write({ page: 3 });
  assert.deepEqual(written, [{ page: 3 }]);
  assert.deepEqual(context.tab.state.read(), { page: 2 });
  assert.equal(Object.isFrozen(context.tab.state), true);
});

test("surface context requires an origin of the one form with null or a local absolute path", () => {
  const root = { appendChild() {} };
  const runtime = { exposure: { command() {} }, sidecar() {}, command() {}, emit() {}, native: {} };
  const at = 'surface "tab-o": view start origin';
  const form = `${at} is not {directory} with a path or null`;
  const refused = [
    [undefined, `${at} is missing`],
    [null, form],
    [[], form],
    [{}, form],
    [{ directory: "/a", root: "/a" }, form],
    [{ directory: 3 }, form],
    [{ directory: "" }, `${at} directory is empty`],
    [{ directory: "relative" }, `${at} directory is not an absolute path`],
    [{ directory: "C:\\x" }, `${at} directory is not an absolute path`],
    [{ directory: "/C:/x" }, `${at} directory is not an absolute path`],
    [{ directory: "//s/x" }, `${at} directory is not an absolute path`],
    [{ directory: "a\u0000b" }, `${at} directory is not an absolute path`],
  ];
  for (const [origin, text] of refused) {
    assert.throws(() => createSurfaceContext({ origin, closing: CLOSING, root, surfaceId: "tab-o", runtime, tab: TAB, icon: ICON }),
      (error) => error instanceof TypeError && error.message === text, `origin ${JSON.stringify(origin)} is refused with its text`);
  }
  assert.equal(createSurfaceContext({ origin: { directory: null }, closing: CLOSING, root, surfaceId: "tab-o", runtime, tab: TAB, icon: ICON }).origin.directory, null);
  assert.equal(createSurfaceContext({ origin: { directory: "/a" }, closing: CLOSING, root, surfaceId: "tab-o", runtime, tab: TAB, icon: ICON }).origin.directory, "/a");
});
