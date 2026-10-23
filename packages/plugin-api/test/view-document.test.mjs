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

function setup(t, { surface = true, params = { path: "sample.txt" } } = {}) {
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
  if (surface) view.sokSurface = { surface: "probe-tab", params, declarations };
  view.sokTheme = { scheme: "dark", tokens: { "--bg": "rgb(1, 2, 3)" } };
  view.document.documentElement.style.colorScheme = "dark";
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
  return { view, bridge, request, registrations, posted };
}

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
  const { view, bridge, registrations, request } = setup(t);
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
  const next = await request("status.next", "core.surface.input", { version: 0 });
  assert.deepEqual(next.value, events);
  assert.deepEqual(pluginRequests, [], "the plugin exposure listener answered a core document request");
  await request("status.unwatch", "core.surface.input");
});

test("the document audit includes separate binders and open shadow roots and releases disposed bindings", { timeout: 5000 }, async (t) => {
  const { view, registrations, request } = setup(t);
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
  const next = await request("status.next", "core.surface.document", { version: 0 });
  assert.deepEqual(next.value.unbound, [{ tag: "button", expose: "probe.shadow", command: null, text: "Shadow" }]);
  assert.deepEqual(first.audit(view.document.body), [], "the document audit changed an individual binder's contract");
  await request("status.unwatch", "core.surface.document");
});

test("a plugin host bridge registers no surface document entries", { timeout: 5000 }, async (t) => {
  const { registrations } = setup(t, { surface: false });
  await turn();
  assert.deepEqual(registrations(), []);
});

test("document watchers observe delegated shadow controls and mutations and close after unwatch", { timeout: 5000 }, async (t) => {
  const { view, request } = setup(t);
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
  let version = (await request("status.next", "core.surface.document", { version: 0 })).version;
  binder.mark(shadow.querySelector("button"), "probe.press");
  binder.delegate(shadow);
  let update = await request("status.next", "core.surface.document", { version });
  version = update.version;
  assert.equal(update.value.unbound.some(({ expose }) => expose === "probe.late"), false);
  shadow.querySelector("button").removeAttribute("data-expose");
  await turn();
  update = await request("status.next", "core.surface.document", { version });
  assert.equal(update.value.unbound.some(({ command, expose }) => command === "probe.press" && expose === null), true);
  binder.dispose();
  await request("status.unwatch", "core.surface.document");
  assert.deepEqual(await request("status.next", "core.surface.document", { version: update.version }), { closed: true });
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
