// Common view document exposure runs in the core bridge, including pages that register no plugin entries.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createBinder } from "../binder.js";
import { createViewBridge } from "../view.js";
import { observeSurfaceDocument } from "../surface-document.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const coreNames = ["core.surface.document", "core.surface.hit", "core.surface.input"];
const declarations = {
  status: ["document", "input"].map((name) => ({ name: `core.surface.${name}`, description: name, schema: {} })),
  commands: [{ name: "core.surface.hit", description: "Hits the document.", params: { type: "object" }, result: { type: "boolean" } }],
  dom: [],
};

function setup(t, { surface = true, params = { path: "sample.txt" }, levels } = {}) {
  const dom = new JSDOM("<!doctype html><body><button data-expose=probe.button>Press</button></body>",
    { url: "soksak://probe/ui/view.html", runScripts: "outside-only" });
  const view = dom.window;
  const posted = [];
  const host = (data) => view.dispatchEvent(new view.MessageEvent("message", { data, source: view }));
  const handler = { postMessage(message) {
    posted.push(message);
    if (message.sok === 1 && message.id !== undefined && message.command) {
      queueMicrotask(() => host({ sok: 1, id: message.id, result: null }));
    }
  } };
  view.webkit = { messageHandlers: { "sok-view": handler } };
  view.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
  if (surface) view.sokSurface = { surface: "probe-tab", params, declarations, ...(levels ? { levels } : {}) };
  view.sokTheme = { scheme: "dark", tokens: { "--bg": "rgb(1, 2, 3)" } };
  const viewport = new view.EventTarget();
  Object.assign(viewport, { width: 400.5, height: 200.5 });
  Object.defineProperty(view, "visualViewport", { value: viewport });
  const priorWindow = globalThis.window;
  globalThis.window = view;
  const failures = [];
  const bridge = createViewBridge({ handler, report: (error) => { if (error.kind !== "open-calls") failures.push(error); } });
  t.after(() => {
    view.dispatchEvent(new view.Event("pagehide"));
    view.close();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    assert.deepEqual(failures, [], "the bridge reported a failure");
  });
  const registrations = () => posted.filter((message) => message.command === "runtime.native.call" && message.params.name === "registered")
    .map((message) => message.params.payload.name).sort();
  let id = 700;
  const request = async (method, name, params = {}) => {
    const requestId = ++id;
    host({ sok: 1, event: "exposure-request", data: { id: requestId, surface: "probe-tab", method, params: { name, ...params } } });
    await turn();
    const replies = posted.filter((message) => message.command === "runtime.native.call"
      && message.params.name === "exposureReply" && message.params.payload.id === requestId);
    assert.equal(replies.length, 1, `${name} must have exactly one document answer`);
    const payload = replies[0].params.payload;
    assert.equal(payload.error, undefined, `${name}: ${JSON.stringify(payload.error)}`);
    return payload.result;
  };
  // The values that the view sent for a watched status, as {value, version}, in order.
  const changes = (name) => posted.filter((message) => message.command === "runtime.native.call"
    && message.params.name === "changed" && message.params.payload.name === name)
    .map((message) => ({ value: message.params.payload.value, version: message.params.payload.version }));
  return { view, bridge, request, registrations, posted, changes, host };
}

// A view is a separate document and does not inherit the stylesheet of the main page, so the bridge sets the theme of the start
// script and each later theme message on the root of the view document (docs/spec/native-surfaces.md#view-surfaces, F352).
test("the bridge sets the start theme and each later theme message on the root of the view document", { timeout: 5000 }, async (t) => {
  const { view, host } = setup(t);
  const root = view.document.documentElement;
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(root.style.getPropertyValue("--bg"), "rgb(1, 2, 3)");
  host({ sok: 1, event: "theme", data: { scheme: "light", tokens: { "--bg": "rgb(4, 5, 6)", "--fg": "rgb(7, 8, 9)" } } });
  assert.equal(root.style.colorScheme, "light");
  assert.equal(root.style.getPropertyValue("--bg"), "rgb(4, 5, 6)");
  assert.equal(root.style.getPropertyValue("--fg"), "rgb(7, 8, 9)");
});

test("the bridge registers the actual view document without plugin exposure setup", { timeout: 5000 }, async (t) => {
  const { view, registrations, request } = setup(t);
  view.sokSurface.params.path = "mutated.txt";
  await turn();
  assert.deepEqual(registrations(), coreNames, "the view bridge registered no common document entries");
  const state = await request("status.get", "core.surface.document");
  assert.equal(state.url, "soksak://probe/ui/view.html");
  assert.deepEqual(state.params, { path: "sample.txt" }, "the status must preserve the params present when the view bridge started");
  assert.equal(state.timeOrigin, view.performance.timeOrigin);
  assert.equal(state.themed, true);
  assert.deepEqual(state.viewport, { width: 400.5, height: 200.5 });
  assert.deepEqual(state.body, state.viewport);
  assert.equal(state.unbound.length, 1);
  view.document.elementFromPoint = (x, y) => x === 20 && y === 30 ? view.document.body : null;
  assert.equal(await request("command.run", "core.surface.hit", { params: { x: 20, y: 30 } }), true);
  assert.equal(await request("command.run", "core.surface.hit", { params: { x: 0, y: 0 } }), false);
});

test("the document status preserves null view start params", { timeout: 5000 }, async (t) => {
  const { request } = setup(t, { params: null });
  await turn();
  const state = await request("status.get", "core.surface.document");
  assert.equal(state.params, null, "the status must preserve a declared null params value");
});

test("the document observer rejects missing or malformed view start params", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "soksak://probe/ui/view.html" });
  const view = dom.window;
  const viewport = new view.EventTarget();
  Object.assign(viewport, { width: 400, height: 200 });
  Object.defineProperty(view, "visualViewport", { value: viewport });
  t.after(() => view.close());
  view.sokSurface = {};
  assert.throws(() => observeSurfaceDocument(view), /window\.sokSurface\.params is missing/);
  view.sokSurface.params = "sample.txt";
  assert.throws(() => observeSurfaceDocument(view), /window\.sokSurface\.params must be an object or null/);
  view.sokSurface.params = {};
  view.sokSurface.params.self = view.sokSurface.params;
  assert.throws(() => observeSurfaceDocument(view), /window\.sokSurface\.params is not JSON serializable/);
});

test("view input records its actual document events and core requests have one owner", { timeout: 5000 }, async (t) => {
  const { view, bridge, registrations, request, changes } = setup(t);
  const pluginRequests = [];
  await bridge.runtime.native.on("exposure-request", (value) => pluginRequests.push(value));
  await turn();
  assert.deepEqual(registrations(), coreNames);
  await request("status.watch", "core.surface.input");
  for (let i = 0; i < 34; i++) view.document.body.dispatchEvent(new view.MouseEvent("pointerdown",
    { bubbles: true, clientX: i, clientY: 19, shiftKey: true, metaKey: true }));
  const events = await request("status.get", "core.surface.input");
  assert.equal(events.length, 32);
  assert.deepEqual(events[0], { sequence: 3, type: "pointerdown", trusted: false, x: 2, y: 19,
    key: null, modifiers: ["shift", "command"] });
  assert.deepEqual(changes("core.surface.input").at(-1).value, events, "the last change sent the value that the read returns");
  assert.deepEqual(pluginRequests, [], "the plugin exposure listener answered a core document request");
  await request("status.unwatch", "core.surface.input");
});

test("the document audit includes separate binders and open shadow roots and releases disposed bindings", { timeout: 5000 }, async (t) => {
  const { view, registrations, request, changes } = setup(t);
  const first = createBinder(async () => {}, { check() {} });
  const second = createBinder(async () => {}, { check() {} });
  t.after(() => { first.dispose(); second.dispose(); });
  first.bind(view.document.querySelector("button"), "probe.press");
  const root = view.document.body.appendChild(view.document.createElement("div")).attachShadow({ mode: "open" });
  root.innerHTML = "<button data-expose=probe.shadow>Shadow</button>";
  second.bind(root.querySelector("button"), "probe.press");
  await turn();
  assert.deepEqual(registrations(), coreNames);
  assert.deepEqual((await request("status.get", "core.surface.document")).unbound, []);
  await request("status.watch", "core.surface.document");
  second.dispose();
  await turn();
  assert.deepEqual(changes("core.surface.document").at(-1).value.unbound, [{ tag: "button", expose: "probe.shadow", command: null, text: "Shadow" }]);
  assert.deepEqual(first.audit(view.document.body), [], "the document audit changed an individual binder's contract");
  await request("status.unwatch", "core.surface.document");
});

test("a view bridge without a surface registers no surface document entries", { timeout: 5000 }, async (t) => {
  const { registrations } = setup(t, { surface: false });
  await turn();
  assert.deepEqual(registrations(), []);
});

test("document watchers observe delegated shadow controls and mutations and close after unwatch", { timeout: 5000 }, async (t) => {
  const { view, request, changes } = setup(t);
  await turn();
  const host = view.document.body.appendChild(view.document.createElement("section"));
  await turn();
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<button data-expose=probe.late>Late</button>";
  const unbound = await request("status.get", "core.surface.document");
  assert.equal(unbound.unbound.some(({ expose }) => expose === "probe.late"), true,
    "an explicit read must discover an unbound shadow root attached to an existing host");
  const binder = createBinder(async () => {}, { check() {} });
  t.after(() => binder.dispose());
  await request("status.watch", "core.surface.document");
  const first = changes("core.surface.document").at(-1);
  binder.mark(shadow.querySelector("button"), "probe.press");
  binder.delegate(shadow);
  await turn();
  let update = changes("core.surface.document").at(-1);
  assert.ok(update.version > first.version, "the delegation sent a newer version");
  assert.equal(update.value.unbound.some(({ expose }) => expose === "probe.late"), false);
  shadow.querySelector("button").removeAttribute("data-expose");
  await turn();
  await turn();
  update = changes("core.surface.document").at(-1);
  assert.equal(update.value.unbound.some(({ command, expose }) => command === "probe.press" && expose === null), true);
  binder.dispose();
  await request("status.unwatch", "core.surface.document");
  const sent = changes("core.surface.document").length;
  shadow.querySelector("button").setAttribute("data-expose", "probe.again");
  await turn();
  await turn();
  assert.equal(changes("core.surface.document").length, sent, "an unwatched document status sends no change");
});


test("disposing document observation releases input, mutation and binding notifications", { timeout: 5000 }, async (t) => {
  const { view } = setup(t, { surface: false });
  view.sokSurface = { params: null };
  const state = observeSurfaceDocument(view);
  let documents = 0;
  let inputs = 0;
  state.document.subscribe(() => documents++);
  state.input.subscribe(() => inputs++);
  view.dispatchEvent(new view.MouseEvent("pointerdown", { clientX: 4, clientY: 5 }));
  assert.equal(inputs, 1);
  state.dispose();
  state.dispose();
  const binder = createBinder(async () => {}, { check() {} });
  t.after(() => binder.dispose());
  binder.bind(view.document.querySelector("button"), "probe.press");
  view.document.body.appendChild(view.document.createElement("button"));
  view.dispatchEvent(new view.MouseEvent("pointerup"));
  view.dispatchEvent(new view.Event("resize"));
  view.visualViewport.dispatchEvent(new view.Event("resize"));
  await turn();
  assert.equal(inputs, 1);
  assert.equal(documents, 0);
  assert.equal(state.input.read().length, 1);
});

// A view is a document of its own, so it reports its focused exposed element to the page, which combines it with the first
// responder of the window in core.focus (docs/spec/exposure.md#keyboard-focus).
test("the bridge reports each change of the focused exposed element of the view with tab.focus", { timeout: 5000 }, async (t) => {
  const { view, posted } = setup(t);
  const field = view.document.createElement("input");
  field.dataset.expose = "probe.field";
  const plain = view.document.createElement("input");
  view.document.body.append(field, plain);
  await turn();
  const focusCalls = () => posted.filter((message) => message.command === "tab.focus").map((message) => message.params);
  const button = view.document.querySelector("button");
  button.focus();
  await turn();
  field.focus();
  await turn();
  field.blur();
  field.focus();
  await turn();
  plain.focus();
  await turn();
  assert.deepEqual(focusCalls(), [{ name: "probe.button", index: 0 }, { name: "probe.field", index: 0 }, null],
    "the view did not report each change of its focused exposed element once");
});

test("the bridge cancels the default menu of a right click in the view and sends surface.menu with its point", { timeout: 5000 }, async (t) => {
  const { view, posted } = setup(t);
  await turn();
  const menuCalls = () => posted.filter((message) => message.command === "surface.menu").map((message) => message.params);
  const click = new view.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 12.5 });
  view.document.querySelector("button").dispatchEvent(click);
  await turn();
  assert.equal(click.defaultPrevented, true, "the default context menu of the web view was not cancelled");
  assert.deepEqual(menuCalls(), [{ x: 30, y: 12.5 }]);
  const own = new view.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
  view.document.body.addEventListener("contextmenu", (event) => event.preventDefault(), { once: true });
  view.document.body.dispatchEvent(own);
  await turn();
  assert.deepEqual(menuCalls(), [{ x: 30, y: 12.5 }], "a right click that the plugin cancelled sent surface.menu");
});

// The page reads the stored level of each class to skip building data that the writer would not store
// (docs/spec/native-surfaces.md#view-surfaces).
test("runtime.log.levels returns the start levels, subscribes once and returns the levels of the last notice", async (t) => {
  const start = Object.freeze({ lifecycle: "error", input: "error", call: "error", io: "error", frame: "error" });
  const { bridge, posted, host } = setup(t, { levels: start });
  assert.deepEqual(bridge.runtime.log.levels(), start);
  await turn();
  assert.deepEqual(bridge.runtime.log.levels(), start);
  assert.equal(posted.filter((message) => message.command === "runtime.log.levels.on").length, 1, "the first read subscribes the page");
  host({ sok: 1, event: "log.levels", data: { ...start, frame: "debug" } });
  assert.deepEqual(bridge.runtime.log.levels(), { ...start, frame: "debug" });
  assert.equal(posted.filter((message) => message.command === "runtime.log.levels.on").length, 1, "a later read subscribes no more");
});

test("the start of a run requests one frame of the view and no later frame", async (t) => {
  const { view, host } = setup(t);
  const frames = [];
  view.requestAnimationFrame = (fn) => frames.push(fn);
  host({ sok: 1, event: "run-start", data: null });
  assert.equal(frames.length, 1, "the start of a run requests a frame");
  frames.shift()();
  assert.equal(frames.length, 0, "a frame of the start of a run requests no next frame");
});
