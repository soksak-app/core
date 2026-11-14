import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS, surfaceDocumentEntry, validateExposureFile } from "@soksak/plugin-api";
import { host, selectPageWire } from "@soksak/runtime";

// The document and the declarations of the fixtures. They use no real plugin name.
const dom = new JSDOM(`<body>
  <button data-expose="core.fixture.button">b</button>
  <span data-expose="core.fixture.row">r0</span><span data-expose="core.fixture.row">r1</span>
</body>`, { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// The trace of the page leaves through the host wire, and the trace module reads the wire when it is imported, so the modules are
// imported while a case without calls is selected. Each test that traces selects its own case (docs/spec/cases/page-wire/README.md).
const imports = selectPageWire("exposure-none");
const { createRegistry, installExposure, isSectionSurface, markViewSurface, registry, registerSurfacePort, dispatchSurfaceRequest } = await import("../exposure.js");
const { setTraceEnabled } = await import("../performance.js");
const { flushEvents } = await import("../page-log.js");
const { logGate } = await import("../log-gate.js");
imports.finish();

/** The fields of each trace event of the name that the page sent in its log batches, in the order of the batches. */
const tracedEvents = (wire, event) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload.action === "batch")
  .flatMap(({ payload }) => payload.events)
  .filter((record) => record.event === `workbench.trace.${event}`)
  .map((record) => record.fields);

/**
 * Runs body with the trace switched on through the case of the name, sends the batches and switches the trace off. The events of
 * the trace are at the level debug of the classes call and frame, so the policy stores that level while the trace is on, as the
 * debug setting of the person does.
 */
async function withTrace(name, body) {
  const wire = selectPageWire(name);
  logGate.set({ lifecycle: "error", input: "error", call: "debug", io: "error", frame: "debug" });
  await setTraceEnabled(true);
  try {
    await body(wire);
  } finally {
    await setTraceEnabled(false);
    logGate.set({ lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" });
  }
  wire.finish();
}

test("mounted surface exposure routes through its registered module and releases ownership", async () => {
  const received = [];
  const port = async (request) => { received.push(request); };
  const remove = registerSurfacePort("fixture-surface", port);
  const request = { surface: "fixture-surface", id: 1, method: "status.get" };
  try {
    assert.equal(await dispatchSurfaceRequest(request), true);
    assert.deepEqual(received, [request]);
    assert.throws(() => registerSurfacePort("fixture-surface", port), /already has/);
    remove();
    assert.equal(await dispatchSurfaceRequest(request), false);
  } finally {
    remove();
  }
});

test("a view surface answers its core document entries without reaching the main page port", async () => {
  const surface = "fixture-view-surface";
  const received = [];
  const remove = registerSurfacePort(surface, async (request) => { received.push(request.id); });
  const unmark = markViewSurface(surface);
  try {
    assert.equal(await dispatchSurfaceRequest({ surface, id: 1, method: "status.get", params: { name: "fixture-view.lines" } }), true);
    assert.equal(await dispatchSurfaceRequest({ surface, id: 2, method: "status.get", params: { name: "core.surface.document" } }), true);
    assert.equal(await dispatchSurfaceRequest({ surface, id: 3, method: "exposure.list", params: {} }), true);
    assert.deepEqual(received, [], "a request of the view reached the main page placeholder");
    unmark();
    assert.equal(await dispatchSurfaceRequest({ surface, id: 4, method: "status.get", params: { name: "fixture-view.lines" } }), true);
    assert.deepEqual(received, [4], "a surface that is no longer a view does not consume its requests");
  } finally {
    unmark();
    remove();
  }
});

const coreExposes = () => ({
  status: [
    { name: "core.fixture.count", description: "Count.", schema: { type: "integer" } },
    { name: "core.surface.document", description: "Registered by surface pages.", schema: {} },
  ],
  commands: [{ name: "core.fixture.add", description: "Adds.", params: { type: "object", properties: { n: { type: "integer" } } }, result: { type: "integer" } }],
  element: [
    { name: "core.fixture.button", description: "Button." },
    { name: "core.fixture.row", description: "Rows.", many: true },
    { name: "core.fixture.missing", description: "Absent." },
  ],
});

const probeExposes = () => ({
  status: [{ name: "probe.lines", description: "Lines.", schema: { type: "array" } }],
  commands: [{ name: "probe.send", description: "Sends.", params: { type: "object" }, result: {} }],
  element: [{ name: "probe.lines", description: "Output." }],
});

// The host calls of a registry are answered by its page-wire case (docs/spec/cases/page-wire/README.md): the replies are those of the host
// to exposureForward and exposureChanged. open selects the case of the name and returns the host of the page.
let wire = null;
function open(name) {
  wire = selectPageWire(name);
  return host;
}
/** The host calls of the registry as [name, arg]. */
const calls = () => wire.calls.map(({ name, payload }) => [name, payload]);

function coreRegistry(host, report = (error) => { throw error; }) {
  const made = createRegistry(host ? { call: host.call, report } : {});
  made.declare("core", coreExposes());
  made.declare("probe", probeExposes());
  return made;
}

// The trace tests run before the tests that gate events: the count of gated events leaves with a later batch, and a trace case
// records the batches of its own events only.
test("command timing names endpoint and UI commands at the registry boundary", () => withTrace("exposure-trace-command", async (wire) => {
  const made = createRegistry();
  made.declare("core", coreExposes());
  made.command("core.fixture.add", ({ n }) => n + 1);
  assert.deepEqual(await made.handle({ method: "command.run", params: {
    name: "core.fixture.add", params: { n: 2 },
  } }), { result: 3 });
  assert.equal(await made.run("core.fixture.add", { n: 3 }), 4);
  await flushEvents();
  assert.deepEqual(tracedEvents(wire, "command").map(({ name }) => name), ["core.fixture.add", "core.fixture.add"]);
}));

test("registration tracing attributes core loss to its document and live request callback", () => withTrace("exposure-trace-registration", async (wire) => {
  const records = [];
  const traced = async () => {
    await flushEvents();
    records.splice(0, records.length, ...tracedEvents(wire, "surface.registration").map((fields) => ({ event: "surface.registration", ...fields })));
  };
  const registerObservedPort = registerSurfacePort;
  const made = createRegistry();
  made.declare("core", coreExposes());
  made.declare("probe", probeExposes());
  made.configure({ surfacePlugin: () => "probe" });
  const surface = "registration-timeline-surface";
  const remove = registerObservedPort(surface, async () => {});
  try {
    made.registered({ surface, kind: "status", name: "core.surface.document" });
    made.registered({ surface, closed: true });
    made.registered({ surface, kind: "status", name: "probe.lines" });
    await traced();
    assert.deepEqual(records.map((record) => record.phase), ["registered", "closed", "registered"]);
    assert.equal(records[1].event, "surface.registration");
    assert.equal(records[1].hasPort, true, "the close lost its live callback attribution");
    assert.equal(records[1].timeOrigin, performance.timeOrigin);
    assert.deepEqual(records[1].names, ["status core.surface.document"], "the close lost the removed core names");
    made.unregisterSurface(surface);
    await traced();
    assert.equal(records.at(-1).phase, "disposed");
    assert.deepEqual(records.at(-1).names, ["status probe.lines"]);
  } finally {
    remove();
  }
}));

test("a value that no watch takes is recorded in the trace with its reason", () => withTrace("exposure-registry-dropped-trace", async (wire) => {
  const createTracedRegistry = createRegistry;
  const made = createTracedRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("core", coreExposes());
  made.declare("probe", probeExposes());
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["early"], version: 1 });
  await made.handle({ method: "status.watch", params: { name: "probe.lines" } });
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["b"], version: 2 });
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["a"], version: 1 });
  await flushEvents();
  const dropped = tracedEvents(wire, "surface.change.dropped");
  assert.deepEqual(dropped, [
    { surface: "tab-a", name: "probe.lines", version: 1, reason: "no watch" },
    { surface: "tab-a", name: "probe.lines", version: 1, reason: "older than version 2" },
  ]);
}));

test("the core declaration file is valid and every main-page entry is registered by core-exposure.js or marked in markup", () => {
  const file = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
  validateExposureFile(file);
  const source = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const code = source("core-exposure.js");
  // The core view bridge registers only the three common document entries.
  const main = (list) => list.filter(({ name }) => !surfaceDocumentEntry(name));
  assert.ok(file.exposes.status.some(({ name }) => surfaceDocumentEntry(name)), "surface document entries are declared");
  for (const { name } of main(file.exposes.status)) assert.match(code, new RegExp(`status\\("${name}"`), name);
  for (const { name } of main(file.exposes.commands)) assert.match(code, new RegExp(`command\\("${name}"`), name);
  // Reads every owning module of the staging declaration. A separated operation module passes the same name check.
  const modules = JSON.parse(source("package.json")).files.filter((name) => name.endsWith(".js"));
  const markup = ["index.html", ...modules].map(source).join("\n");
  for (const { name } of file.exposes.element) {
    assert.ok(markup.includes(`"${name}"`) || markup.includes(`'${name}'`), `${name} has no data-expose in the markup`);
  }});

test("the registry registers the core declarations of the exposure file", () => {
  const served = { exposes: coreExposes() };
  installExposure(structuredClone(served));
  const listed = registry.list();
  assert.deepEqual(Object.keys(listed), ["status", "commands", "element"]);
  assert.deepEqual(listed.commands, [{ ...served.exposes.commands[0], registered: false }],
    "entries keep the declaration format and add registered");
  assert.deepEqual(Object.values(listed).flat().map((entry) => `${entry.name} ${entry.registered}`), [
    "core.fixture.count false",
    "core.surface.document false",
    "core.fixture.add false",
    "core.fixture.button false",
    "core.fixture.row false",
    "core.fixture.missing false",
  ], "nothing is registered before core registration");
  registry.element("core.fixture.row");
  assert.equal(registry.list().element.find((entry) => entry.name === "core.fixture.row").registered, true);
});

test("core entries answer requests and undeclared or unregistered names fail with their codes", async () => {
  const host = open("exposure-registry-core-entries");
  const made = coreRegistry(host);
  assert.throws(() => made.status("core.fixture.other", () => 0, () => {}), /not declared/);
  assert.throws(() => made.declare("core", { status: [{ name: "probe.x", description: "x", schema: {} }] }), /core.<name>/);
  assert.throws(() => made.declare("probe", probeExposes()), /declared twice/);

  let count = 1;
  let emit = null;
  made.status("core.fixture.count", () => count, (fn) => { emit = fn; return () => { emit = null; }; });
  made.command("core.fixture.add", ({ n }) => (count += n));
  made.element("core.fixture.button");
  made.element("core.fixture.row");
  made.element("core.fixture.missing");

  const code = async (request) => (await made.handle(request)).error?.code;
  assert.equal(await code({ method: "status.get", params: { name: "core.fixture.none" } }), EXPOSURE_ERRORS.unknownName);
  assert.equal(await code({ method: "element.rect", params: { name: "core.fixture.missing" } }), EXPOSURE_ERRORS.unregistered);
  assert.equal(await code({ method: "command.run", params: { name: "core.fixture.add", params: { n: "1" } } }), EXPOSURE_ERRORS.invalidParams);
  assert.equal(await code({ method: "windows.list", params: {} }), EXPOSURE_ERRORS.unknownMethod);

  assert.deepEqual(await made.handle({ method: "status.get", params: { name: "core.fixture.count" } }), { result: 1 });
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "core.fixture.add", params: { n: 2 } } }), { result: 3 });

  const button = document.querySelector('[data-expose="core.fixture.button"]');
  button.getBoundingClientRect = () => ({ left: 4, top: 5, width: 6, height: 7 });
  assert.deepEqual(await made.handle({ method: "element.rect", params: { name: "core.fixture.button" } }),
    { result: { x: 4, y: 5, width: 6, height: 7, zoom: 1, role: "button", document: { x: 0, y: 0 } } });
  let clicked = 0;
  button.addEventListener("click", () => clicked++);
  assert.deepEqual(await made.handle({ method: "element.act", params: { name: "core.fixture.button", action: "click" } }), { result: null });
  assert.equal(clicked, 1);
  const rows = [...document.querySelectorAll('[data-expose="core.fixture.row"]')];
  const seen = [];
  rows[1].addEventListener("keydown", (event) => seen.push([event.key, event.isTrusted]));
  await made.handle({ method: "element.act", params: { name: "core.fixture.row", index: 1, action: "dispatch", event: { type: "keydown", key: "Escape" } } });
  assert.deepEqual(seen, [["Escape", false]]);

  assert.deepEqual(await made.handle({ method: "status.watch", params: { name: "core.fixture.count" } }), { result: null });
  emit(3);
  count = 4;
  emit(count);
  await made.handle({ method: "status.unwatch", params: { name: "core.fixture.count" } });
  assert.equal(emit, null, "unwatch releases the subscription");
  assert.deepEqual(calls().filter(([name]) => name === "exposureChanged").map(([, arg]) => arg), [
    { name: "core.fixture.count", value: 3 },
    { name: "core.fixture.count", value: 4 },
  ], "the first value is sent once and repeated values are not sent");

  const listed = made.list();
  const find = (key, name) => listed[key].find((entry) => entry.name === name);
  assert.equal(find("status", "core.fixture.count").registered, true);
  assert.equal(find("element", "core.fixture.missing").registered, false);
  assert.equal(find("status", "probe.lines").registered, false);
  assert.equal(find("commands", "core.fixture.add").params.type, "object");
  assert.equal("kind" in find("commands", "core.fixture.add"), false);
  assert.deepEqual(await made.handle({ method: "exposure.list", params: {} }), { result: made.list() });
  wire.finish();
});

test("diagnostic methods are answered by their registered handlers", async () => {
  const made = coreRegistry(open("exposure-none"));
  made.method("diagnostics.fixture", async ({ root }) => ({ root }));
  assert.throws(() => made.method("diagnostics.fixture", () => null), /already registered/);
  assert.deepEqual(await made.handle({ method: "diagnostics.fixture", params: { root: "/tmp/x" } }), { result: { root: "/tmp/x" } });
  made.method("diagnostics.knob", () => { throw new Error("bad knob"); });
  assert.deepEqual(await made.handle({ method: "diagnostics.knob", params: {} }),
    { error: { code: EXPOSURE_ERRORS.failed, message: "bad knob" } });
  wire.finish();
});

test("surface registrations are checked against the declarations and the surface's plugin", () => {
  const made = coreRegistry(open("exposure-none"));
  const plugins = { "tab-a": "probe", "tab-b": "probe", "tab-c": "other" };
  let changes = 0;
  made.configure({ surfacePlugin: (surface) => plugins[surface] ?? null, registrationChanged: () => changes++ });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  made.registered({ surface: "tab-a", kind: "element", name: "probe.lines" });
  assert.throws(() => made.registered({ surface: "tab-a", kind: "command", name: "probe.lines" }), /undeclared command probe.lines/);
  assert.throws(() => made.registered({ surface: "tab-a", kind: "status", name: "core.fixture.count" }), /undeclared/);
  assert.throws(() => made.registered({ surface: "tab-c", kind: "command", name: "probe.send" }), /of plugin other cannot register/);
  made.registered({ surface: "tab-x", kind: "command", name: "probe.send" });
  made.registered({ surface: "tab-z", kind: "command", name: "probe.send" });
  assert.deepEqual([made.namesOf("tab-x"), made.namesOf("tab-z")], [[], []], "surfaces of unknown plugins are held");
  plugins["tab-x"] = "probe";
  plugins["tab-z"] = "other";
  assert.throws(() => made.revisit(), /tab-z of plugin other cannot register/, "held registrations are checked when the surface is known");
  assert.deepEqual([made.namesOf("tab-x"), made.namesOf("tab-z")], [["command probe.send"], []]);
  made.revisit();
  made.registered({ surface: "tab-y", kind: "command", name: "probe.send" });
  made.registered({ surface: "tab-y", closed: true });
  plugins["tab-y"] = "probe";
  made.revisit();
  assert.deepEqual(made.namesOf("tab-y"), [], "a closed surface drops its held registrations");
  assert.deepEqual(made.namesOf("tab-a"), ["status probe.lines", "element probe.lines"]);
  assert.equal(changes, 4, "each accepted registration and closed surface is reported");
  made.registered({ surface: "tab-a", closed: true });
  assert.equal(changes, 5, "a closed surface is reported");
  assert.deepEqual(made.namesOf("tab-a"), []);
  assert.equal(made.list().status.find((entry) => entry.name === "probe.lines").registered, false);
  wire.finish();
});

test("the surface menu command is owned by the main document", { timeout: 5000 }, async () => {
  const made = createRegistry();
  made.declare("core", { commands: [{ name: "core.surface.menu", description: "Opens the menu.",
    params: { type: "object" }, result: { type: "string" } }] });
  made.command("core.surface.menu", () => "main menu");
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "core.surface.menu", params: {} } }),
    { result: "main menu" });
  assert.deepEqual(made.surfaceDeclarations().commands, [], "the menu was handed to the view document");
});

test("a view rectangle uses the selected surface's current applied origin once", { timeout: 5000 }, async () => {
  const local = { x: 12, y: 24, width: 80, height: 30 };
  const made = coreRegistry(open("exposure-registry-view-rectangle"));
  const placements = new Map([
    ["tab-a", { x: 215.25, y: 116.5, w: 400, h: 300, visible: true }],
    ["tab-b", { x: 700, y: 95, w: 200, h: 100, visible: true }],
  ]);
  const unmarks = [...placements.keys()].map((surface) => markViewSurface(surface));
  made.configure({ surfacePlugin: () => "probe", preferred: () => ["tab-b"],
    surfaceFrame: (surface) => placements.get(surface) });
  for (const surface of placements.keys()) made.registered({ surface, kind: "element", name: "probe.lines" });
  try {
    for (const [surface, placement] of placements) {
      const result = (await made.handle({ method: "element.rect", params: { name: "probe.lines", surface } })).result;
      assert.deepEqual(result, { ...local, x: local.x + placement.x, y: local.y + placement.y, document: { x: 0, y: 0 } });
    }
    placements.set("tab-b", { x: 120, y: 180, w: 0, h: 0, visible: false });
    const moved = (await made.handle({ method: "element.rect", params: { name: "probe.lines" } })).result;
    assert.deepEqual(moved, { ...local, x: 132, y: 204, document: { x: 0, y: 0 } },
      "the preferred hidden view uses its applied origin without scaling or a guessed viewport ratio");
    placements.delete("tab-b");
    assert.match((await made.handle({ method: "element.rect", params: { name: "probe.lines" } })).error.message,
      /tab-b.*applied frame/, "a missing applied frame must not become a valid-looking zero origin");
  } finally {
    for (const unmark of unmarks) unmark();
  }  wire.finish();
});


test("a view mark is owned by its mount: the dispose of an earlier mount of the same surface keeps the view's mark", async () => {
  const request = { id: 9, surface: "tab-mark", method: "status.get", params: { name: "probe.lines" } };
  const earlier = markViewSurface("tab-mark");
  const later = markViewSurface("tab-mark");
  earlier();
  // The later mount still runs the view, so the view answers the request and no surface port does.
  assert.equal(await dispatchSurfaceRequest(request), true, "the view mark ended with the earlier mount");
  later();
  assert.equal(await dispatchSurfaceRequest(request), false, "a surface without a view mark and without a port took the request");
});

test("mounted surface rectangles retain application coordinates after layout changes", { timeout: 10000 }, async () => {
  const rectangles = new Map([
    ["tab-a", { x: 210, y: 116, width: 233.5, height: 286.5 }],
    ["tab-b", { x: 705, y: 116, width: 487, height: 286.5 }],
    ["tab-c", { x: 457.5, y: 116, width: 233.5, height: 286.5 }],
  ]);
  const host = open("exposure-registry-rectangles-retain");
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  for (const surface of rectangles.keys()) made.registered({ surface, kind: "element", name: "probe.lines" });
  for (const offset of [0, -200, 0]) {
    for (const [surface, before] of rectangles) {
      const expected = { ...before, x: before.x + offset };
      rectangles.set(surface, expected);
      const { result } = await made.handle({ method: "element.rect", params: { name: "probe.lines", surface } });
      assert.deepEqual(result, { ...expected, document: { x: 0, y: 0 } });
      assert.equal(result.document.x + result.x + result.width / 2, expected.x + expected.width / 2);
      assert.equal(result.document.y + result.y + result.height / 2, expected.y + expected.height / 2);
      rectangles.set(surface, before);
    }
  }  wire.finish();
});

test("an independent document retains its explicit origin", { timeout: 10000 }, async () => {
  const made = coreRegistry(null);
  const modal = { x: 12, y: 24, width: 30, height: 20, document: { x: 300, y: 180 } };
  made.method("element.rect", () => modal);
  assert.deepEqual(await made.handle({ method: "element.rect", params: { name: "core.fixture.button" } }), { result: modal });
});

test("requests for surface names are forwarded to the preferred surface in the application document", { timeout: 10000 }, async () => {
  const host = open("exposure-registry-preferred-surface");
  const made = coreRegistry(host);
  let preferred = [];
  made.configure({
    surfacePlugin: () => "probe",
    preferred: () => preferred,
  });
  assert.equal((await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } })).error.code,
    EXPOSURE_ERRORS.unregistered);
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  made.registered({ surface: "tab-b", kind: "command", name: "probe.send" });
  made.registered({ surface: "tab-a", kind: "element", name: "probe.lines" });
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } }), { result: "tab-b" },
    "without a preference the latest registration receives the request");
  preferred = ["tab-c", "tab-a"];
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } }), { result: "tab-a" });
  assert.deepEqual(await made.handle({ method: "element.rect", params: { name: "probe.lines" } }),
    { result: { x: 1, y: 2, width: 3, height: 4, document: { x: 0, y: 0 } } });
  const forwarded = calls().filter(([name]) => name === "exposureForward").map(([, arg]) => arg);
  assert.deepEqual(forwarded.at(-1).params, { name: "probe.lines" });
  assert.equal(forwarded.at(-1).surface, "tab-a");
  assert.equal(new Set(forwarded.map((arg) => arg.id)).size, forwarded.length, "every forward has its own id");
  assert.equal((await made.handle({ method: "status.get", params: { name: "probe.lines" } })).error.code, EXPOSURE_ERRORS.unregistered);
  wire.finish();
});

// A command has no time limit, so the registry refuses a declaration that states one (`timeout` in docs/spec/exposure.md).
// contract: exposure.command.declaration-refuses-a-time-limit
test("the registry refuses a command declaration with timeout and keeps no time limit of a command", () => {
  const made = createRegistry();
  made.declare("core", coreExposes());
  const slow = probeExposes();
  slow.commands.push({ name: "probe.wait", description: "Waits.", params: { type: "object" }, result: {}, timeout: 120000 });
  assert.throws(() => made.declare("probe", slow), { message: "probe exposes probe.wait: timeout is not a member of a command declaration" });
  assert.equal(made.declared("command", "probe.wait"), false, "a refused declaration was registered");
  assert.equal("commandTimeout" in made, false, "the registry gives a time limit of a command");
});

test("a forwarded request carries no timeout", async () => {
  const host = open("exposure-registry-no-timeout");
  const made = createRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("core", coreExposes());
  const slow = probeExposes();
  slow.commands.push({ name: "probe.wait", description: "Waits.", params: { type: "object" }, result: {} });
  made.declare("probe", slow);
  made.configure({ surfacePlugin: () => "probe" });
  for (const name of ["probe.send", "probe.wait"]) made.registered({ surface: "tab-a", kind: "command", name });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  await made.handle({ method: "command.run", params: { name: "probe.wait", params: {} } });
  await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } });
  await made.handle({ method: "status.get", params: { name: "probe.lines" } });
  const forwarded = calls().filter(([name]) => name === "exposureForward").map(([, arg]) => arg);
  assert.equal(forwarded.length, 3);
  // The members are those of exposureForward; origin is present only for a forward made for an exposure-request with an id.
  for (const request of forwarded) assert.deepEqual(Object.keys(request).filter((key) => key !== "origin").sort(), ["id", "method", "params", "surface"]);
  wire.finish();
});

// A forward that the main page makes while it handles an exposure-request carries origin, the id of that request, so the end of
// the endpoint connection that sent it ends the forward on the host; a forward that the page starts itself carries no origin
// (exposureForward in docs/spec/exposure.md).
function originRegistry(name) {
  const host = open(name);
  const made = createRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("core", coreExposes());
  made.declare("probe", probeExposes());
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  made.registered({ surface: "tab-a", kind: "element", name: "probe.lines" });
  const forwards = () => calls().filter(([name]) => name === "exposureForward").map(([, arg]) => arg);
  return { made, forwards };
}

// contract: exposure.relay.connection-end-ends-its-requests
test("a forward made while the main page handles an exposure-request carries the id of that request as origin", async () => {
  const { made, forwards } = originRegistry("exposure-registry-origin-request");
  await made.handle({ id: 41, method: "command.run", params: { name: "probe.send", params: {} } });
  await made.handle({ id: 42, method: "status.get", params: { name: "probe.lines" } });
  await made.handle({ id: 43, method: "element.rect", params: { name: "probe.lines" } });
  await made.handle({ id: 44, method: "status.watch", params: { name: "probe.lines" } });
  await made.handle({ id: 45, method: "status.unwatch", params: { name: "probe.lines" } });
  assert.deepEqual(forwards().map(({ method, origin }) => [method, origin]), [
    ["command.run", 41], ["status.get", 42], ["element.rect", 43], ["status.watch", 44], ["status.unwatch", 45],
  ]);
  assert.equal(new Set(forwards().map(({ id }) => id)).size, 5, "each forward keeps its own id");
});

test("a forward that the main page starts itself carries no origin", async () => {
  const { made, forwards } = originRegistry("exposure-registry-origin-none");
  assert.equal(await made.run("probe.send", {}), null);
  const values = [];
  const stop = made.observe("probe.lines", "tab-a", (value) => values.push(value), { exact: true });
  stop();
  assert.deepEqual(forwards().map(({ method }) => method), ["command.run", "status.watch", "status.unwatch"]);
  for (const forward of forwards()) assert.equal(Object.hasOwn(forward, "origin"), false, `${forward.method} carries origin`);
});

test("the core exposure file declares no command with timeout", () => {
  const file = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
  const timed = file.exposes.commands.filter((command) => "timeout" in command).map((command) => command.name);
  assert.deepEqual(timed, [], "exposure.json declares a time limit of a command");
  assert.doesNotThrow(() => validateExposureFile(file));
});

test("run executes a core command locally with schema checks", async () => {
  const made = coreRegistry(null);
  made.command("core.fixture.add", ({ n }) => n + 1);
  assert.equal(await made.run("core.fixture.add", { n: 2 }), 3);
  await assert.rejects(made.run("core.fixture.add", { n: "two" }), { code: EXPOSURE_ERRORS.invalidParams });
  await assert.rejects(made.run("core.fixture.missing", {}), { code: EXPOSURE_ERRORS.unknownName });
});

test("a watched surface status receives the values that the surface sends, and no forward waits for a change", async () => {
  const host = open("exposure-registry-watched-status");
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  // Both watch requests have resolved, so the forwards they start have been made; no request of the module waits for a change.
  assert.deepEqual(await made.handle({ method: "status.watch", params: { name: "probe.lines" } }), { result: null });
  assert.deepEqual(await made.handle({ method: "status.watch", params: { name: "probe.lines" } }), { result: null });
  const forwarded = (method) => calls().filter(([name, arg]) => name === "exposureForward" && arg.method === method);
  assert.deepEqual(forwarded("status.next"), [], "a watch sends no request that waits for a change");
  assert.equal(forwarded("status.watch").length, 1, "a second watch is not forwarded");
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["a"], version: 1 });
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["b"], version: 2 });
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["stale"], version: 1 });
  made.changed({ surface: "tab-b", name: "probe.lines", value: ["other"], version: 3 });
  const changes = () => calls().filter(([name]) => name === "exposureChanged").map(([, arg]) => arg);
  assert.deepEqual(changes(), [
    { name: "probe.lines", value: ["a"] },
    { name: "probe.lines", value: ["b"] },
  ], "each newer value of the watched surface is sent once, and an older version or another surface is not");
  assert.deepEqual(await made.handle({ method: "status.unwatch", params: { name: "probe.lines" } }), { result: null });
  assert.equal(forwarded("status.unwatch").length, 1);
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["c"], version: 3 });
  assert.equal(changes().length, 2, "a value after unwatch is not sent");
  wire.finish();
});

test("a status change that the host refuses is reported with the status name", async () => {
  const reported = [];
  const host = open("exposure-registry-change-refused");
  let refused;
  const refusal = new Promise((resolve) => { refused = resolve; });
  const made = coreRegistry(host, (error) => { reported.push(error.message); refused(); });
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  assert.deepEqual(await made.handle({ method: "status.watch", params: { name: "probe.lines" } }), { result: null });
  made.changed({ surface: "tab-a", name: "probe.lines", value: null, version: 1 });
  await refusal;
  assert.deepEqual(reported, ["status probe.lines change was refused: argument request.value is missing"]);
  assert.throws(() => createRegistry({ call: host.call }), /a registry with a host call needs report\(error\)/);
  wire.finish();
});

test("without a host the registry answers in the page and cannot forward", async () => {
  const made = coreRegistry(null);
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  assert.equal((await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } })).error.code,
    EXPOSURE_ERRORS.gone);
  let count = 0;
  made.status("core.fixture.count", () => count, () => () => {});
  assert.deepEqual(await made.handle({ method: "status.watch", params: { name: "core.fixture.count" } }), { result: null });
  count = 1;
  assert.deepEqual(await made.handle({ method: "status.get", params: { name: "core.fixture.count" } }), { result: 1 });
});

test("a status watch that the surface refuses is not kept, so the next watch is forwarded again", async () => {
  const host = open("exposure-registry-watch-refused");
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  assert.equal((await made.handle({ method: "status.watch", params: { name: "probe.lines" } })).error.code, EXPOSURE_ERRORS.gone);
  made.changed({ surface: "tab-a", name: "probe.lines", value: ["a"], version: 1 });
  assert.deepEqual(calls().filter(([name]) => name === "exposureChanged"), [], "a refused watch delivers no value");
  await made.handle({ method: "status.watch", params: { name: "probe.lines" } });
  assert.equal(calls().filter(([name, arg]) => name === "exposureForward" && arg.method === "status.watch").length, 2,
    "a new watch is forwarded after the refused one");
  wire.finish();
});

test("an observation of a surface that ended is no failure, and its watch is forwarded again when the surface registers", async () => {
  let refuse = true;
  const host = open("exposure-registry-observation-ended");
  const made = coreRegistry(host);
  const failures = [];
  made.configure({ surfacePlugin: () => "probe", failed: (error) => { failures.push(error.message); return true; } });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  const stop = made.observe("probe.lines", "tab-a", () => {}, { exact: true });
  await made.idle();
  assert.deepEqual(failures, [], "the end of the surface is not a failure of the observation");

  refuse = false;
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  await made.idle();
  assert.equal(calls().filter(([name, arg]) => name === "exposureForward" && arg.method === "status.watch").length, 2,
    "the watch is forwarded again when the surface registers");
  stop();
  wire.finish();
});

test("an observation that another error refuses is reported as a failure", async () => {
  const host = open("exposure-registry-observation-failed");
  const made = coreRegistry(host);
  const failures = [];
  made.configure({ surfacePlugin: () => "probe", failed: (error) => { failures.push(error.message); return true; } });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  const stop = made.observe("probe.lines", "tab-a", () => {}, { exact: true });
  await made.idle();
  assert.deepEqual(failures, ["probe.lines on tab-a: the read threw"]);
  stop();
  wire.finish();
});

test("an observation chooses no surface that a drawing or a place left out, so no watch is forwarded to it", async () => {
  // A place closes the views that it leaves out before their own ends reach the registry (docs/spec/plugins.md#sections).
  const host = open("exposure-registry-left-out");
  const made = coreRegistry(host);
  const left = new Set(["tab-b"]);
  made.configure({ surfacePlugin: () => "probe", preferred: () => ["tab-b", "tab-a"], leftOut: (surface) => left.has(surface) });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  made.registered({ surface: "tab-b", kind: "status", name: "probe.lines" });
  const exact = [];
  const chosen = [];
  made.observe("probe.lines", "tab-b", (value, from) => exact.push([value, from]), { exact: true });
  made.observe("probe.lines", undefined, (value, from) => chosen.push(from));
  // observe forwards its watch to the host before it returns, so the recorded calls hold every watch that the observations start.
  const watched = calls().filter(([name, arg]) => name === "exposureForward" && arg.method === "status.watch").map(([, arg]) => arg.surface);
  assert.deepEqual(watched, ["tab-a"], "a watch was forwarded to a surface that is left out");
  assert.deepEqual(exact, [[null, null]], "an exact observation of a left-out surface follows no surface");
  assert.deepEqual(chosen, [], "the observation without a surface waits for the value of tab-a");
  wire.finish();
});

test("a request to an unloaded surface fails with tab <id> is unloaded", async () => {
  const made = coreRegistry(open("exposure-none"));
  made.configure({ surfacePlugin: () => "probe", unloaded: (surface) => surface === "tab-u" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  const reply = await made.handle({ method: "status.get", params: { name: "probe.lines", surface: "tab-u" } });
  assert.deepEqual(reply.error, { code: EXPOSURE_ERRORS.unregistered, message: "tab tab-u is unloaded" });
  wire.finish();
});

test("surface pages register core surface entries, and requests can name the surface", async () => {
  const host = open("exposure-registry-surface-pages");
  const made = coreRegistry(host);
  const plugins = { "tab-a": "probe", "tab-b": "probe" };
  made.configure({ surfacePlugin: (surface) => plugins[surface] ?? null, preferred: () => ["tab-a"] });
  made.registered({ surface: "tab-a", kind: "status", name: "core.surface.document" });
  made.registered({ surface: "tab-b", kind: "status", name: "core.surface.document" });
  made.registered({ surface: "tab-b", kind: "status", name: "probe.lines" });
  made.registered({ surface: "tab-x", kind: "status", name: "core.surface.document" });
  assert.deepEqual(made.namesOf("tab-x"), [], "a core surface entry of an unknown surface is held");
  assert.equal(made.list().status.find((entry) => entry.name === "core.surface.document").registered, true);

  const get = (params) => made.handle({ method: "status.get", params });
  assert.deepEqual(await get({ name: "core.surface.document" }), { result: "core.surface.document@tab-a" });
  assert.deepEqual(await get({ name: "core.surface.document", surface: "tab-b" }), { result: "core.surface.document@tab-b" });
  assert.equal((await get({ name: "probe.lines", surface: "tab-a" })).error.code, EXPOSURE_ERRORS.unregistered,
    "a surface that has not registered the name is rejected");
  assert.equal((await get({ name: "probe.lines", surface: 3 })).error.code, EXPOSURE_ERRORS.invalidParams);

  await made.handle({ method: "status.watch", params: { name: "core.surface.document", surface: "tab-b" } });
  await made.handle({ method: "status.watch", params: { name: "core.surface.document" } });
  for (const surface of ["tab-b", "tab-a"]) made.changed({ surface, name: "core.surface.document", value: surface, version: 1 });
  assert.deepEqual(calls().filter(([name]) => name === "exposureChanged").map(([, arg]) => arg), [
    { name: "core.surface.document", surface: "tab-b", value: "tab-b" },
    { name: "core.surface.document", value: "tab-a" },
  ], "a watch that named a surface reports it, and watches with and without a surface are separate");
  const forwarded = (method) => calls().filter(([name, arg]) => name === "exposureForward" && arg.method === method)
    .map(([, arg]) => [arg.surface, arg.params]);
  assert.deepEqual(forwarded("status.watch"), [
    ["tab-b", { name: "core.surface.document" }],
    ["tab-a", { name: "core.surface.document" }],
  ]);
  await made.handle({ method: "status.unwatch", params: { name: "core.surface.document", surface: "tab-b" } });
  assert.deepEqual(forwarded("status.unwatch"), [["tab-b", { name: "core.surface.document" }]]);
  wire.finish();
});

test("a core command answers after the configured settling work", async () => {
  const made = createRegistry();
  made.declare("core", coreExposes());
  made.command("core.fixture.add", ({ n }) => n + 1);
  // The settling work is a thenable: the command must await it, and the mark of its then shows that it did. A command that does not
  // await it answers with no mark before its answer, whatever the timing of the test.
  const order = [];
  let release = null;
  let finished = false;
  const drawing = { then(resolve) { order.push("awaited"); if (finished) resolve(); else release = resolve; } };
  let settling;
  const reached = new Promise((resolve) => { settling = resolve; });
  made.configure({ settled: () => { settling(); return drawing; } });
  const answer = made.run("core.fixture.add", { n: 1 }).then((value) => { order.push("answered"); return value; });
  await reached;
  finished = true;
  release?.();
  assert.equal(await answer, 2);
  assert.deepEqual(order, ["awaited", "answered"], "the command answered before the settling work was awaited");
});

test("a handled settling failure is reported and does not reject the state-changing command", async () => {
  const made = createRegistry();
  made.declare("core", coreExposes());
  made.command("core.fixture.add", ({ n }) => n + 1);
  const failures = [];
  made.configure({
    settled: async () => { throw new Error("presentation failed"); },
    failed: (error) => { failures.push(error.message); return true; },
  });
  assert.equal(await made.run("core.fixture.add", { n: 1 }), 2);
  assert.deepEqual(failures, ["presentation failed"]);
});

test("observe follows a surface status in the page, switches surfaces on registration, and stops on dispose", async () => {
  const host = open("exposure-registry-observe-follows");
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe", preferred: () => [] });
  // The surface sends its current value after the host forwarded the watch to it.
  const first = (surface) => made.changed({ surface, name: "probe.lines", value: [`${surface} first`], version: 1 });
  const seen = [];
  const stop = made.observe("probe.lines", "tab-b", (value, surface) => seen.push([surface, value]));
  assert.deepEqual(seen, [[null, null]], "without a registered surface the observer receives null");
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  first("tab-a");
  await made.idle();
  assert.deepEqual(seen.at(-1), ["tab-a", ["tab-a first"]], "the only registered surface is followed");
  made.registered({ surface: "tab-b", kind: "status", name: "probe.lines" });
  first("tab-b");
  await made.idle();
  assert.deepEqual(seen.at(-1), ["tab-b", ["tab-b first"]], "the requested surface is followed once it registers");
  const changes = calls().filter(([name]) => name === "exposureChanged");
  assert.equal(changes.length, 0, "a page observer sends no exposureChanged");
  stop();
  await made.idle();
  const unwatched = calls().filter(([name, arg]) => name === "exposureForward" && arg.method === "status.unwatch")
    .map(([, arg]) => arg.surface);
  assert.deepEqual(unwatched, ["tab-a", "tab-b"]);
  wire.finish();
});

test("a section surface id is recognized by its sidebar and section form, and a tab id is not", () => {
  assert.equal(isSectionSurface("spc-aaaaaa/left/probe.tree"), true);
  assert.equal(isSectionSurface("spc-aaaaaa/c3:right/probe.dom"), true);
  assert.equal(isSectionSurface("tab-a"), false);
  assert.equal(isSectionSurface("c3:tab"), false);
});

test("a request without surface chooses a tab surface, and a section surface answers only a request that names it", async () => {
  const host = open("exposure-registry-section-surface");
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe", preferred: () => ["spc-aaaaaa/left/probe.tree"] });
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  made.registered({ surface: "spc-aaaaaa/left/probe.tree", kind: "command", name: "probe.send" });
  made.registered({ surface: "spc-aaaaaa/right/probe.dom", kind: "command", name: "probe.send" });
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } }), { result: "tab-a" },
    "the preferred and the latest registrations are section surfaces, so the tab surface answers");
  made.registered({ surface: "spc-aaaaaa/left/probe.tree", kind: "status", name: "probe.lines" });
  assert.equal((await made.handle({ method: "status.get", params: { name: "probe.lines" } })).error.code, EXPOSURE_ERRORS.unregistered,
    "a status that only a section surface registers is not chosen without surface");
  assert.deepEqual(await made.handle({ method: "status.get", params: { name: "probe.lines", surface: "spc-aaaaaa/left/probe.tree" } }),
    { result: "spc-aaaaaa/left/probe.tree" }, "the section surface answers a request that names it");
  wire.finish();
});

test("run forwards a plugin command to the named surface", async () => {
  const host = open("exposure-registry-run-forwards");
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  made.registered({ surface: "tab-b", kind: "command", name: "probe.send" });
  assert.equal(await made.run("probe.send", {}, "tab-a"), "tab-a");
  await assert.rejects(made.run("probe.send", {}, "tab-c"), { code: EXPOSURE_ERRORS.unregistered });
  wire.finish();
});

test("runOwned runs a command of the plugin on the named surface, and otherwise on a tab surface of the plugin", async () => {
  const host = open("exposure-registry-run-owned");
  const made = coreRegistry(host);
  const plugins = { "tab-a": "probe", "tab-b": "probe", "spc-aaaaaa/left/probe.tree": "probe" };
  made.configure({ surfacePlugin: (surface) => plugins[surface] ?? null, preferred: () => ["tab-b"] });
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  made.registered({ surface: "tab-b", kind: "command", name: "probe.send" });
  made.registered({ surface: "spc-aaaaaa/left/probe.tree", kind: "command", name: "probe.send" });
  assert.equal(await made.runOwned("probe.send", {}, "probe", [], "tab-a"), "tab-a");
  assert.equal(await made.runOwned("probe.send", {}, "probe", []), "tab-b", "without surface the preferred tab surface of the plugin runs it");
  await assert.rejects(made.runOwned("probe.send", {}, "probe", [], "tab-c"),
    { code: EXPOSURE_ERRORS.unregistered, message: "surface tab-c has not registered command probe.send" });
  await assert.rejects(made.runOwned("probe.other", {}, "probe", []),
    { code: EXPOSURE_ERRORS.unregistered, message: "owner probe has not registered command probe.other" });
  wire.finish();
});

test("runOwned without surface runs a command on the calling section surface when it registered it", async () => {
  const host = open("exposure-registry-run-owned-caller");
  const plugins = { "tab-a": "probe", "spc-aaaaaa/left/probe.tree": "probe", "spc-aaaaaa/left/probe.other": "probe" };
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: (surface) => plugins[surface] ?? null, preferred: () => [] });
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  made.registered({ surface: "spc-aaaaaa/left/probe.tree", kind: "command", name: "probe.send" });
  assert.equal(await made.runOwned("probe.send", {}, "probe", [], undefined, "spc-aaaaaa/left/probe.tree"), "spc-aaaaaa/left/probe.tree");
  assert.equal(await made.runOwned("probe.send", {}, "probe", [], undefined, "spc-aaaaaa/left/probe.other"), "tab-a",
    "a caller that has not registered the command leaves the choice to the tab surfaces");
  const sectionOnly = coreRegistry(host);
  sectionOnly.configure({ surfacePlugin: (surface) => plugins[surface] ?? null, preferred: () => [] });
  sectionOnly.registered({ surface: "spc-aaaaaa/left/probe.tree", kind: "command", name: "probe.send" });
  assert.equal(await sectionOnly.runOwned("probe.send", {}, "probe", [], undefined, "spc-aaaaaa/left/probe.tree"),
    "spc-aaaaaa/left/probe.tree", "a section runs its own command while the plugin has no tab");
  await assert.rejects(sectionOnly.runOwned("probe.send", {}, "probe", [], undefined, "spc-aaaaaa/left/probe.other"),
    { code: EXPOSURE_ERRORS.unregistered, message: "owner probe has not registered command probe.send" });
  wire.finish();
});

test("observe reports a failed watch, value read, or release instead of hiding it", async () => {
  const host = open("exposure-registry-observe-failed");
  const made = coreRegistry(host);
  const failures = [];
  made.configure({ surfacePlugin: () => "probe", failed: (error) => failures.push(error.message) });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  const stopA = made.observe("probe.lines", "tab-a", () => {});
  await made.idle();
  assert.deepEqual(failures, ["probe.lines on tab-a: watch lost"]);
  stopA();
  made.registered({ surface: "tab-b", kind: "status", name: "probe.lines" });
  const stopB = made.observe("probe.lines", "tab-b", () => {});
  const stopC = made.observe("probe.lines", "tab-b", () => {});
  await made.idle();
  assert.deepEqual(failures.slice(1), ["probe.lines on tab-b: read lost"], "a joined observer reports a failed read");
  stopB();
  stopC();
  await made.idle();
  assert.deepEqual(failures.slice(2), ["probe.lines on tab-b: unwatch lost"]);
  wire.finish();
});

test("a plugin state registers entries in the page that answer before surfaces and that observers follow", async () => {
  const host = open("exposure-registry-plugin-state");
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  let lines = ["x"];
  const listeners = new Set();
  const state = made.plugin("probe");
  assert.throws(() => made.plugin("probe"), /already registered/);
  assert.throws(() => state.status("core.fixture.count", () => 0, () => () => {}), /does not belong to probe/);
  state.status("probe.lines", () => lines, (fn) => { listeners.add(fn); return () => listeners.delete(fn); });
  state.command("probe.send", ({ n }) => `page ${n}`);
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "probe.send", params: { n: 1 } } }), { result: "page 1" });
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "probe.send", params: {}, surface: "tab-a" } }),
    { result: "from tab-a" }, "a request naming a surface still reaches it");
  assert.equal(await made.run("probe.send", { n: 2 }), "page 2");
  assert.equal(made.list().status.find((entry) => entry.name === "probe.lines").registered, true);
  const seen = [];
  const stop = made.observe("probe.lines", "tab-a", (value, source) => seen.push([source, value]));
  await made.idle();
  lines = ["y"];
  for (const fn of listeners) fn(lines);
  assert.deepEqual(seen, [["state", ["x"]], ["state", ["y"]]]);
  // clear() reselects the surfaces synchronously, so the observer has received null when clear() has completed.
  state.clear();
  assert.deepEqual(seen.at(-1), [null, null], "the observer loses the status when the state is cleared");
  assert.equal(listeners.size, 0, "clearing stops the observer's subscription");
  stop();
  made.plugin("probe").clear();
  wire.finish();
});

test("an observation whose watch the surface refuses reports the error with its surface", async () => {
  const reported = [];
  const host = open("exposure-registry-watch-refuses-surface");
  const made = createRegistry({ call: host.call, report: (error) => { throw error; } });
  made.declare("core", coreExposes());
  made.declare("probe", probeExposes());
  made.configure({ surfacePlugin: () => "probe", preferred: () => [], failed: (error) => reported.push(error.message) });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  made.observe("probe.lines", "tab-a", () => {});
  await made.idle();
  assert.deepEqual(reported, ["probe.lines on tab-a: reader crashed"], "the refused watch was not reported with its surface");
  wire.finish();
});

// An open dialog makes the elements outside it inert (docs/spec/exposure.md). A surface document stands behind it as a whole.
test("an open dialog refuses an action on a core element and a surface element, and keeps their rectangles", { timeout: 5000 }, async () => {
  const local = { x: 12, y: 24, width: 80, height: 30 };
  const host = open("exposure-registry-open-dialog");
  const made = coreRegistry(host);
  const button = document.querySelector('[data-expose="core.fixture.button"]');
  let inert = () => false;
  const unmark = markViewSurface("tab-a");
  made.configure({ surfacePlugin: () => "probe", preferred: () => ["tab-a"], elementInert: (element) => inert(element),
    surfaceFrame: () => ({ x: 100, y: 50, w: 400, h: 300, visible: true }) });
  made.registered({ surface: "tab-a", kind: "element", name: "probe.lines" });
  made.element("core.fixture.button");
  made.element("core.fixture.row");
  try {
    let clicked = 0;
    button.addEventListener("click", () => clicked++);
    inert = (element) => element === null || element === button;
    const refusal = (name) => ({ error: { code: EXPOSURE_ERRORS.inert, message: `element ${name} is behind the open dialog and takes no action` } });
    assert.deepEqual(await made.handle({ method: "element.act", params: { name: "core.fixture.button", action: "click" } }), refusal("core.fixture.button"));
    assert.equal(clicked, 0);
    assert.equal((await made.handle({ method: "element.rect", params: { name: "core.fixture.button" } })).error, undefined);
    const forwarded = () => calls().filter(([name, arg]) => name === "exposureForward" && arg.method === "element.act").length;
    assert.deepEqual(await made.handle({ method: "element.act", params: { name: "probe.lines", action: "click" } }), refusal("probe.lines"));
    assert.equal(forwarded(), 0, "the action reached the surface behind the dialog");
    assert.deepEqual((await made.handle({ method: "element.rect", params: { name: "probe.lines" } })).result,
      { ...local, x: 112, y: 74, document: { x: 0, y: 0 } });
    // An element that the dialog holds takes the action.
    assert.deepEqual(await made.handle({ method: "element.act", params: { name: "core.fixture.row", index: 0, action: "click" } }), { result: null });
    inert = () => false;
    assert.deepEqual(await made.handle({ method: "element.act", params: { name: "probe.lines", action: "click" } }), { result: local });
    assert.equal(forwarded(), 1);
  } finally {
    unmark();
  }  wire.finish();
});
