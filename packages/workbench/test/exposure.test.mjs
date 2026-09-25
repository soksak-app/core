import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS, SURFACE_CORE, validateExposureFile } from "@soksak/plugin-api";

// 가짜 문서와 가짜 플러그인 선언. 실제 플러그인 이름을 사용하지 않는다.
const dom = new JSDOM(`<body>
  <button data-expose="core.fixture.button">b</button>
  <span data-expose="core.fixture.row">r0</span><span data-expose="core.fixture.row">r1</span>
</body>`, { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { createRegistry, loadExposure, registry, registerSurfacePort, unregisterSurfacePort, dispatchSurfaceRequest } = await import("../exposure.js");

test("mounted surface exposure routes through its registered module and releases ownership", async () => {
  const received = [];
  const port = async (request) => { received.push(request); };
  const remove = registerSurfacePort("fixture-surface", port);
  const request = { surface: "fixture-surface", id: 1, method: "status.get" };
  try {
    assert.equal(await dispatchSurfaceRequest(request), true);
    assert.deepEqual(received, [request]);
    assert.throws(() => registerSurfacePort("fixture-surface", port), /already has/);
    unregisterSurfacePort("fixture-surface", port);
    assert.equal(await dispatchSurfaceRequest(request), false);
  } finally {
    remove();
  }
});

const coreExposes = () => ({
  status: [
    { name: "core.fixture.count", description: "Count.", schema: { type: "integer" } },
    { name: "core.surface.fixture", description: "Registered by surface pages.", schema: {} },
  ],
  commands: [{ name: "core.fixture.add", description: "Adds.", params: { type: "object", properties: { n: { type: "integer" } } }, result: { type: "integer" } }],
  dom: [
    { name: "core.fixture.button", description: "Button." },
    { name: "core.fixture.row", description: "Rows.", many: true },
    { name: "core.fixture.missing", description: "Absent." },
  ],
});
const probeExposes = () => ({
  status: [{ name: "probe.lines", description: "Lines.", schema: { type: "array" } }],
  commands: [{ name: "probe.send", description: "Sends.", params: { type: "object" }, result: {} }],
  dom: [{ name: "probe.lines", description: "Output." }],
});

/** 호스트 호출을 기록하고, exposureForward 에는 answer 가 정한 답을 준다. */
function fakeHost(answer = () => ({ result: null })) {
  const calls = [];
  return {
    calls,
    call: async (name, arg) => {
      calls.push([name, arg]);
      return name === "exposureForward" ? answer(arg) : null;
    },
  };
}

function coreRegistry(host) {
  const made = createRegistry({ call: host?.call ?? null });
  made.declare("core", coreExposes());
  made.declare("probe", probeExposes());
  return made;
}

test("the core declaration file is valid and every main-page entry is registered by core-exposure.js or marked in markup", () => {
  const file = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
  validateExposureFile(file);
  const source = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const code = source("core-exposure.js");
  // core.surface.* 는 표면 문서가 @soksak/plugin-api/page 로 등록한다.
  const main = (list) => list.filter(({ name }) => !name.startsWith(SURFACE_CORE));
  assert.ok(file.exposes.status.some(({ name }) => name.startsWith(SURFACE_CORE)), "surface document entries are declared");
  for (const { name } of main(file.exposes.status)) assert.match(code, new RegExp(`status\\("${name}"`), name);
  for (const { name } of main(file.exposes.commands)) assert.match(code, new RegExp(`command\\("${name}"`), name);
  const markup = ["index.html", "plane.js", "sidebar-sections.js", "settings-ui.js", "library.js"].map(source).join("\n");
  for (const { name } of file.exposes.dom) {
    assert.ok(markup.includes(`"${name}"`) || markup.includes(`'${name}'`), `${name} has no data-expose in the markup`);
  }
});

test("the registry loads core declarations from the served file", async () => {
  const served = { exposes: coreExposes() };
  globalThis.fetch = async (path) => (path === "/exposure.json"
    ? { ok: true, json: async () => structuredClone(served) } : { ok: false, status: 404 });
  await loadExposure();
  const listed = registry.list();
  assert.deepEqual(Object.keys(listed), ["status", "commands", "dom"]);
  assert.deepEqual(listed.commands, [{ ...served.exposes.commands[0], registered: false }],
    "entries keep the declaration format and add registered");
  assert.deepEqual(Object.values(listed).flat().map((entry) => `${entry.name} ${entry.registered}`), [
    "core.fixture.count false",
    "core.surface.fixture false",
    "core.fixture.add false",
    "core.fixture.button false",
    "core.fixture.row false",
    "core.fixture.missing false",
  ], "nothing is registered before core registration");
  registry.dom("core.fixture.row");
  assert.equal(registry.list().dom.find((entry) => entry.name === "core.fixture.row").registered, true);
});

test("core entries answer requests and undeclared or unregistered names fail with their codes", async () => {
  const host = fakeHost();
  const made = coreRegistry(host);
  assert.throws(() => made.status("core.fixture.other", () => 0, () => {}), /not declared/);
  assert.throws(() => made.declare("core", { status: [{ name: "probe.x", description: "x", schema: {} }] }), /core.<name>/);
  assert.throws(() => made.declare("probe", probeExposes()), /declared twice/);

  let count = 1;
  let emit = null;
  made.status("core.fixture.count", () => count, (fn) => { emit = fn; return () => { emit = null; }; });
  made.command("core.fixture.add", ({ n }) => (count += n));
  made.dom("core.fixture.button");
  made.dom("core.fixture.row");
  made.dom("core.fixture.missing");

  const code = async (request) => (await made.handle(request)).error?.code;
  assert.equal(await code({ method: "status.get", params: { name: "core.fixture.none" } }), EXPOSURE_ERRORS.unknownName);
  assert.equal(await code({ method: "dom.rect", params: { name: "core.fixture.missing" } }), EXPOSURE_ERRORS.unregistered);
  assert.equal(await code({ method: "command.run", params: { name: "core.fixture.add", params: { n: "1" } } }), EXPOSURE_ERRORS.invalidParams);
  assert.equal(await code({ method: "windows.list", params: {} }), EXPOSURE_ERRORS.unknownMethod);

  assert.deepEqual(await made.handle({ method: "status.get", params: { name: "core.fixture.count" } }), { result: 1 });
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "core.fixture.add", params: { n: 2 } } }), { result: 3 });

  const button = document.querySelector('[data-expose="core.fixture.button"]');
  button.getBoundingClientRect = () => ({ left: 4, top: 5, width: 6, height: 7 });
  assert.deepEqual(await made.handle({ method: "dom.rect", params: { name: "core.fixture.button" } }),
    { result: { x: 4, y: 5, width: 6, height: 7, document: { x: 0, y: 0 } } });
  let clicked = 0;
  button.addEventListener("click", () => clicked++);
  assert.deepEqual(await made.handle({ method: "dom.act", params: { name: "core.fixture.button", action: "click" } }), { result: null });
  assert.equal(clicked, 1);
  const rows = [...document.querySelectorAll('[data-expose="core.fixture.row"]')];
  const seen = [];
  rows[1].addEventListener("keydown", (event) => seen.push([event.key, event.isTrusted]));
  await made.handle({ method: "dom.act", params: { name: "core.fixture.row", index: 1, action: "dispatch", event: { type: "keydown", key: "Escape" } } });
  assert.deepEqual(seen, [["Escape", false]]);

  assert.deepEqual(await made.handle({ method: "status.watch", params: { name: "core.fixture.count" } }), { result: null });
  emit(3);
  count = 4;
  emit(count);
  await made.handle({ method: "status.unwatch", params: { name: "core.fixture.count" } });
  assert.equal(emit, null, "unwatch releases the subscription");
  assert.deepEqual(host.calls.filter(([name]) => name === "exposureChanged").map(([, arg]) => arg), [
    { name: "core.fixture.count", value: 3 },
    { name: "core.fixture.count", value: 4 },
  ], "the first value is sent once and repeated values are not sent");

  const listed = made.list();
  const find = (key, name) => listed[key].find((entry) => entry.name === name);
  assert.equal(find("status", "core.fixture.count").registered, true);
  assert.equal(find("dom", "core.fixture.missing").registered, false);
  assert.equal(find("status", "probe.lines").registered, false);
  assert.equal(find("commands", "core.fixture.add").params.type, "object");
  assert.equal("kind" in find("commands", "core.fixture.add"), false);
  assert.deepEqual(await made.handle({ method: "exposure.list", params: {} }), { result: made.list() });
});

test("diagnostic methods are answered by their registered handlers", async () => {
  const made = coreRegistry(fakeHost());
  made.method("diagnostics.fixture", async ({ root }) => ({ root }));
  assert.throws(() => made.method("diagnostics.fixture", () => null), /already registered/);
  assert.deepEqual(await made.handle({ method: "diagnostics.fixture", params: { root: "/tmp/x" } }), { result: { root: "/tmp/x" } });
  made.method("diagnostics.knob", () => { throw new Error("bad knob"); });
  assert.deepEqual(await made.handle({ method: "diagnostics.knob", params: {} }),
    { error: { code: EXPOSURE_ERRORS.failed, message: "bad knob" } });
});

test("surface registrations are checked against the declarations and the surface's plugin", () => {
  const made = coreRegistry(fakeHost());
  const plugins = { "tab-a": "probe", "tab-b": "probe", "tab-c": "other" };
  let changes = 0;
  made.configure({ surfacePlugin: (surface) => plugins[surface] ?? null, registrationChanged: () => changes++ });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  made.registered({ surface: "tab-a", kind: "dom", name: "probe.lines" });
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
  assert.deepEqual(made.namesOf("tab-a"), ["status probe.lines", "dom probe.lines"]);
  assert.equal(changes, 4, "each accepted registration and closed surface is reported");
  made.registered({ surface: "tab-a", closed: true });
  assert.equal(changes, 5, "a closed surface is reported");
  assert.deepEqual(made.namesOf("tab-a"), []);
  assert.equal(made.list().status.find((entry) => entry.name === "probe.lines").registered, false);
});

test("mounted surface rectangles retain application coordinates after layout changes", { timeout: 10000 }, async () => {
  const rectangles = new Map([
    ["tab-a", { x: 210, y: 116, width: 233.5, height: 286.5 }],
    ["tab-b", { x: 705, y: 116, width: 487, height: 286.5 }],
    ["tab-c", { x: 457.5, y: 116, width: 233.5, height: 286.5 }],
  ]);
  const host = fakeHost(({ surface, method }) => {
    assert.equal(method, "dom.rect");
    return { result: rectangles.get(surface) };
  });
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  for (const surface of rectangles.keys()) made.registered({ surface, kind: "dom", name: "probe.lines" });
  for (const offset of [0, -200, 0]) {
    for (const [surface, before] of rectangles) {
      const expected = { ...before, x: before.x + offset };
      rectangles.set(surface, expected);
      const { result } = await made.handle({ method: "dom.rect", params: { name: "probe.lines", surface } });
      assert.deepEqual(result, { ...expected, document: { x: 0, y: 0 } });
      assert.equal(result.document.x + result.x + result.width / 2, expected.x + expected.width / 2);
      assert.equal(result.document.y + result.y + result.height / 2, expected.y + expected.height / 2);
      rectangles.set(surface, before);
    }
  }
});

test("an independent document retains its explicit origin", { timeout: 10000 }, async () => {
  const made = coreRegistry(null);
  const modal = { x: 12, y: 24, width: 30, height: 20, document: { x: 300, y: 180 } };
  made.method("dom.rect", () => modal);
  assert.deepEqual(await made.handle({ method: "dom.rect", params: { name: "core.fixture.button" } }), { result: modal });
});

test("requests for surface names are forwarded to the preferred surface in the application document", { timeout: 10000 }, async () => {
  const host = fakeHost(({ surface, method }) => (method === "dom.rect"
    ? { result: { x: 1, y: 2, width: 3, height: 4 } }
    : method === "command.run" ? { result: surface } : { error: { code: 1003, message: "gone" } }));
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
  made.registered({ surface: "tab-a", kind: "dom", name: "probe.lines" });
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } }), { result: "tab-b" },
    "without a preference the latest registration receives the request");
  preferred = ["tab-c", "tab-a"];
  assert.deepEqual(await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } }), { result: "tab-a" });
  assert.deepEqual(await made.handle({ method: "dom.rect", params: { name: "probe.lines" } }),
    { result: { x: 1, y: 2, width: 3, height: 4, document: { x: 0, y: 0 } } });
  const forwarded = host.calls.filter(([name]) => name === "exposureForward").map(([, arg]) => arg);
  assert.deepEqual(forwarded.at(-1).params, { name: "probe.lines" });
  assert.equal(forwarded.at(-1).surface, "tab-a");
  assert.equal(new Set(forwarded.map((arg) => arg.id)).size, forwarded.length, "every forward has its own id");
  assert.equal((await made.handle({ method: "status.get", params: { name: "probe.lines" } })).error.code, EXPOSURE_ERRORS.unregistered);
});

test("a forwarded command carries the timeout its declaration gives, and other requests carry none", async () => {
  const host = fakeHost(() => ({ result: null }));
  const made = createRegistry({ call: host.call });
  made.declare("core", coreExposes());
  const slow = probeExposes();
  slow.commands.push({ name: "probe.wait", description: "Waits.", params: { type: "object" }, result: {}, timeout: 120000 });
  made.declare("probe", slow);
  made.configure({ surfacePlugin: () => "probe" });
  for (const name of ["probe.send", "probe.wait"]) made.registered({ surface: "tab-a", kind: "command", name });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  await made.handle({ method: "command.run", params: { name: "probe.wait", params: {} } });
  await made.handle({ method: "command.run", params: { name: "probe.send", params: {} } });
  await made.handle({ method: "status.get", params: { name: "probe.lines" } });
  const forwarded = host.calls.filter(([name]) => name === "exposureForward").map(([, arg]) => arg);
  assert.deepEqual(forwarded.map((arg) => arg.timeout), [120000, undefined, undefined]);
  assert.equal(Object.hasOwn(forwarded[1], "timeout"), false);
});

test("run executes a core command locally with schema checks", async () => {
  const made = coreRegistry(null);
  made.command("core.fixture.add", ({ n }) => n + 1);
  assert.equal(await made.run("core.fixture.add", { n: 2 }), 3);
  await assert.rejects(made.run("core.fixture.add", { n: "two" }), { code: EXPOSURE_ERRORS.invalidParams });
  await assert.rejects(made.run("core.fixture.missing", {}), { code: EXPOSURE_ERRORS.unknownName });
});

test("a watched surface status follows status.next replies until unwatch", async () => {
  let release = null;
  const host = fakeHost(({ method, params }) => {
    if (method !== "status.next") return { result: null };
    if (params.version === 0) return { result: { version: 1, value: ["a"] } };
    if (params.version === 1) return { result: { version: 2, value: ["b"] } };
    return new Promise((resolve) => { release = resolve; });
  });
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  assert.deepEqual(await made.handle({ method: "status.watch", params: { name: "probe.lines" } }), { result: null });
  assert.deepEqual(await made.handle({ method: "status.watch", params: { name: "probe.lines" } }), { result: null });
  await new Promise((resolve) => setImmediate(resolve));
  const changes = () => host.calls.filter(([name]) => name === "exposureChanged").map(([, arg]) => arg);
  assert.deepEqual(changes(), [
    { name: "probe.lines", value: ["a"] },
    { name: "probe.lines", value: ["b"] },
  ]);
  const forwarded = (method) => host.calls.filter(([name, arg]) => name === "exposureForward" && arg.method === method);
  assert.equal(forwarded("status.watch").length, 1, "a second watch is not forwarded");
  assert.deepEqual(forwarded("status.next").map(([, arg]) => arg.params.version), [0, 1, 2]);
  assert.deepEqual(await made.handle({ method: "status.unwatch", params: { name: "probe.lines" } }), { result: null });
  assert.equal(forwarded("status.unwatch").length, 1);
  release({ result: { version: 3, value: ["c"] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changes().length, 2, "a value after unwatch is not sent");
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

test("a failed status.next ends the watch", async () => {
  const host = fakeHost(({ method }) => (method === "status.next"
    ? { error: { code: EXPOSURE_ERRORS.gone, message: "gone" } } : { result: null }));
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  await made.handle({ method: "status.watch", params: { name: "probe.lines" } });
  await new Promise((resolve) => setImmediate(resolve));
  const next = () => host.calls.filter(([name, arg]) => name === "exposureForward" && arg.method === "status.next").length;
  assert.equal(next(), 1);
  await made.handle({ method: "status.watch", params: { name: "probe.lines" } });
  assert.equal(host.calls.filter(([name, arg]) => name === "exposureForward" && arg.method === "status.watch").length, 2,
    "a new watch starts after the previous one ended");
});

test("surface pages register core surface entries, and requests can name the surface", async () => {
  const host = fakeHost(({ surface, method, params }) => {
    if (method === "status.get") return { result: `${params.name}@${surface}` };
    if (method === "status.next") {
      return params.version === 0 ? { result: { version: 1, value: surface } } : new Promise(() => {});
    }
    return { result: null };
  });
  const made = coreRegistry(host);
  const plugins = { "tab-a": "probe", "tab-b": "probe" };
  made.configure({ surfacePlugin: (surface) => plugins[surface] ?? null, preferred: () => ["tab-a"] });
  made.registered({ surface: "tab-a", kind: "status", name: "core.surface.fixture" });
  made.registered({ surface: "tab-b", kind: "status", name: "core.surface.fixture" });
  made.registered({ surface: "tab-b", kind: "status", name: "probe.lines" });
  made.registered({ surface: "tab-x", kind: "status", name: "core.surface.fixture" });
  assert.deepEqual(made.namesOf("tab-x"), [], "a core surface entry of an unknown surface is held");
  assert.equal(made.list().status.find((entry) => entry.name === "core.surface.fixture").registered, true);

  const get = (params) => made.handle({ method: "status.get", params });
  assert.deepEqual(await get({ name: "core.surface.fixture" }), { result: "core.surface.fixture@tab-a" });
  assert.deepEqual(await get({ name: "core.surface.fixture", surface: "tab-b" }), { result: "core.surface.fixture@tab-b" });
  assert.equal((await get({ name: "probe.lines", surface: "tab-a" })).error.code, EXPOSURE_ERRORS.unregistered,
    "a surface that has not registered the name is rejected");
  assert.equal((await get({ name: "probe.lines", surface: 3 })).error.code, EXPOSURE_ERRORS.invalidParams);

  await made.handle({ method: "status.watch", params: { name: "core.surface.fixture", surface: "tab-b" } });
  await made.handle({ method: "status.watch", params: { name: "core.surface.fixture" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.calls.filter(([name]) => name === "exposureChanged").map(([, arg]) => arg), [
    { name: "core.surface.fixture", surface: "tab-b", value: "tab-b" },
    { name: "core.surface.fixture", value: "tab-a" },
  ], "a watch that named a surface reports it, and watches with and without a surface are separate");
  const forwarded = (method) => host.calls.filter(([name, arg]) => name === "exposureForward" && arg.method === method)
    .map(([, arg]) => [arg.surface, arg.params]);
  assert.deepEqual(forwarded("status.watch"), [
    ["tab-b", { name: "core.surface.fixture" }],
    ["tab-a", { name: "core.surface.fixture" }],
  ]);
  await made.handle({ method: "status.unwatch", params: { name: "core.surface.fixture", surface: "tab-b" } });
  assert.deepEqual(forwarded("status.unwatch"), [["tab-b", { name: "core.surface.fixture" }]]);
});

test("a core command answers after the configured settling work", async () => {
  const made = createRegistry();
  made.declare("core", coreExposes());
  made.command("core.fixture.add", ({ n }) => n + 1);
  let release;
  const drawing = new Promise((resolve) => { release = resolve; });
  made.configure({ settled: () => drawing });
  let answered = false;
  const answer = made.run("core.fixture.add", { n: 1 }).then((value) => { answered = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, false, "the command answered before the settling work finished");
  release();
  assert.equal(await answer, 2);
});

test("observe follows a surface status in the page, switches surfaces on registration, and stops on dispose", async () => {
  const pending = [];
  const host = fakeHost(({ surface, method, params }) => {
    if (method === "status.get") return { result: [`${surface} now`] };
    if (method !== "status.next") return { result: null };
    if (params.version === 0) return { result: { version: 1, value: [`${surface} first`] } };
    return new Promise((resolve) => pending.push(resolve));
  });
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe", preferred: () => [] });
  const seen = [];
  const stop = made.observe("probe.lines", "tab-b", (value, surface) => seen.push([surface, value]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [[null, null]], "without a registered surface the observer receives null");
  made.registered({ surface: "tab-a", kind: "status", name: "probe.lines" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.at(-1), ["tab-a", ["tab-a first"]], "the only registered surface is followed");
  made.registered({ surface: "tab-b", kind: "status", name: "probe.lines" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.at(-1), ["tab-b", ["tab-b first"]], "the requested surface is followed once it registers");
  const changes = host.calls.filter(([name]) => name === "exposureChanged");
  assert.equal(changes.length, 0, "a page observer sends no exposureChanged");
  stop();
  await new Promise((resolve) => setImmediate(resolve));
  const unwatched = host.calls.filter(([name, arg]) => name === "exposureForward" && arg.method === "status.unwatch")
    .map(([, arg]) => arg.surface);
  assert.deepEqual(unwatched, ["tab-a", "tab-b"]);
});

test("run forwards a plugin command to the named surface", async () => {
  const host = fakeHost(({ surface }) => ({ result: surface }));
  const made = coreRegistry(host);
  made.configure({ surfacePlugin: () => "probe" });
  made.registered({ surface: "tab-a", kind: "command", name: "probe.send" });
  made.registered({ surface: "tab-b", kind: "command", name: "probe.send" });
  assert.equal(await made.run("probe.send", {}, "tab-a"), "tab-a");
  await assert.rejects(made.run("probe.send", {}, "tab-c"), { code: EXPOSURE_ERRORS.unregistered });
});
