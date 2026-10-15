// The embed page of a connector plugin (docs/spec/plugins.md#connected-applications).
import assert from "node:assert/strict";
import test from "node:test";

const LOG = Object.fromEntries(["error", "warn", "info", "debug", "trace"].map((level) => [level, () => {}]));

/** A surface context of the connector plugin sketcher with a view, an image region and a sidecar that record what the page does. */
function surface(program, args = "[]") {
  const listeners = new Map();
  const view = {
    style: {},
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 320, height: 200 }),
  };
  const page = { hidden: false };
  view.hidden = false;
  const root = { set innerHTML(value) {}, querySelector: (selector) => ({ "#view": view, "#page": page })[selector] ?? null, replaceChildren() {} };
  const loads = [];
  const documentRegion = { load: async (url) => { loads.push(url); } };
  const regionListeners = new Map();
  const region = { on(type, fn) { regionListeners.set(type, fn); return () => regionListeners.delete(type); }, focus: async () => { focused += 1; }, setCaret: async (rect) => { carets.push(rect); } };
  let focused = 0;
  const carets = [];
  const sent = [];
  let sidecarListener;
  const sidecar = { async on(id, fn) { sidecarListener = fn; return () => {}; }, async send(id, body) { sent.push(body); } };
  const statuses = new Map();
  const commands = new Map();
  const reports = [];
  const context = {
    surfaceId: "s1",
    pluginId: "sketcher",
    runtime: { log: LOG, sidecar: () => sidecar, settings: { read: () => ({ arguments: args }), on: () => () => {} },
      // The connector plugin sketcher connected its application at the path program; null states that it is not connected.
      applications: { read: () => (program === null ? {} : { sketcher: { version: "1.0.0", path: program, how: "installed", method: "release" } }), on: () => () => {} } },
    composition: { async create() { sent.push("composition.create"); return { region: (name) => (name === "page" ? documentRegion : region), dispose: async () => {} }; } },
    exposure: {
      status: async (name, read, subscribe) => statuses.set(name, { read, subscribe }),
      command: async (name, fn) => commands.set(name, fn), dom: async () => {}, bind: async () => {}, delegate: async () => {},
      dispose: async () => {},
    },
    status: { report: (phase, error) => reports.push([phase, error?.message]) },
  };
  return {
    context, root, view, page, loads, sent, statuses, commands, reports, carets,
    focused: () => focused,
    fire: (type, event) => listeners.get(type).forEach((fn) => fn({ preventDefault() {}, ...event })),
    region: (type, event) => regionListeners.get(type)(event),
    message: (body) => sidecarListener(body),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the page opens the connected application and reports ready", async () => {
  const s = surface("/opt/editor");
  const { mountApplication: mount } = await import("../application-page.js");
  await mount(s.root, s.context, { application: "sketcher" });
  // The host finishes the composition only after the first frame of the image region, which the application draws, so the
  // page opens the application before it creates the composition.
  assert.deepEqual(s.sent.slice(0, 2), [{ operation: "open", command: ["/opt/editor"] }, "composition.create"]);
  assert.deepEqual(s.reports, [["ready", undefined]]);
  assert.equal(s.statuses.get("sketcher.state").read().program, "/opt/editor");
});

test("pointer and wheel events of the view become embed input in points of the region", async () => {
  const s = surface("/opt/editor");
  const { mountApplication: mount } = await import("../application-page.js");
  await mount(s.root, s.context, { application: "sketcher" });
  s.fire("pointerdown", { clientX: 40, clientY: 70, button: 0, buttons: 1, pointerId: 1, shiftKey: true, altKey: false, ctrlKey: false, metaKey: false });
  s.fire("pointermove", { clientX: 41, clientY: 72, button: -1, buttons: 1, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false });
  s.fire("pointerup", { clientX: 41, clientY: 72, button: 0, buttons: 0, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false });
  s.fire("wheel", { clientX: 50, clientY: 60, deltaX: 0, deltaY: -12, deltaMode: 0 });
  await settle();
  const messages = s.sent.filter((body) => body.operation === "input").map((body) => body.message);
  assert.deepEqual(messages[0], { type: "pointer", phase: "down", x: 30, y: 50, button: "left", buttons: ["left"], shift: true, alt: false, ctrl: false, meta: false, input: 1 });
  assert.deepEqual(messages[1], { type: "pointer", phase: "move", x: 31, y: 52, buttons: ["left"], shift: false, alt: false, ctrl: false, meta: false, input: 2 });
  assert.equal(messages[2].phase, "up");
  assert.deepEqual(messages[2].buttons, []);
  assert.deepEqual(messages[3], { type: "scroll", x: 40, y: 40, dx: 0, dy: -12, precise: true, input: 4 });
  assert.equal(s.focused(), 0, "a press passes through without moving the keyboard; sketcher.focus moves it");
});

test("region keyboard events become embed key, commit, compose and focus messages", async () => {
  const s = surface("/opt/editor");
  const { mountApplication: mount } = await import("../application-page.js");
  await mount(s.root, s.context, { application: "sketcher" });
  await s.region("key", { key: "ArrowLeft", shift: false, alt: true, ctrl: false });
  await s.region("insert", { text: "한" });
  await s.region("compose", { text: "ㅎ", caret: 1 });
  await s.region("focus", { focused: true });
  const messages = s.sent.filter((body) => body.operation === "input").map((body) => body.message);
  const key = { type: "key", key: "ArrowLeft", shift: false, alt: true, ctrl: false, meta: false, repeat: false };
  assert.deepEqual(messages, [
    { ...key, down: true }, { ...key, down: false },
    { type: "commit", text: "한" },
    { type: "compose", text: "ㅎ", caret: 1 },
    { type: "focus", focused: true },
  ]);
});

test("messages of the sidecar set the cursor, the caret and the state, and errors are reported", async () => {
  const s = surface("/opt/editor");
  const { mountApplication: mount } = await import("../application-page.js");
  await mount(s.root, s.context, { application: "sketcher" });
  s.message({ event: "started", pid: 42 });
  s.message({ event: "connected", toolkit: "slint" });
  s.message({ event: "cursor", shape: "resize-ew" });
  s.message({ event: "caret", x: 1, y: 2, width: 3, height: 4 });
  s.message({ event: "state", title: "project" });
  s.message({ error: "the host refused frame 3 of the region view: size" });
  s.message({ event: "exited", exit: "exit status 0" });
  await settle();
  assert.equal(s.view.style.cursor, "ew-resize");
  assert.deepEqual(s.carets, [{ x: 1, y: 2, width: 3, height: 4 }]);
  assert.deepEqual(s.statuses.get("sketcher.state").read(), { program: "/opt/editor", pid: 42, toolkit: "slint", cursor: "resize-ew", title: "project", exit: "exit status 0", error: "the host refused frame 3 of the region view: size" });
  assert.deepEqual(s.reports.at(-1), ["error", "the host refused frame 3 of the region view: size"]);
});

test("the focus command focuses the region and the input command sends one embed input message", async () => {
  const s = surface("/opt/editor");
  const { mountApplication: mount } = await import("../application-page.js");
  await mount(s.root, s.context, { application: "sketcher" });
  await s.commands.get("sketcher.focus")({});
  assert.equal(s.focused(), 1);
  const message = { type: "commit", text: "a" };
  await s.commands.get("sketcher.input")({ message });
  assert.deepEqual(s.sent.at(-1), { operation: "input", message });
  await assert.rejects(s.commands.get("sketcher.input")({ message: { type: "end" } }), /input: end is not an input message/);
});

test("the arguments of the setting follow the program in the command", async () => {
  const s = surface("/opt/editor", '["--project", "/tmp/a project"]');
  const { mountApplication: mount } = await import("../application-page.js");
  await mount(s.root, s.context, { application: "sketcher" });
  assert.deepEqual(s.sent[0], { operation: "open", command: ["/opt/editor", "--project", "/tmp/a project"] });
});

test("arguments that are not a JSON array of strings are an error and start nothing", async () => {
  const s = surface("/opt/editor", "--project /tmp");
  const { mountApplication: mount } = await import("../application-page.js");
  await mount(s.root, s.context, { application: "sketcher" });
  assert.equal(s.sent.some((body) => body.operation === "open"), false);
  assert.deepEqual(s.reports.at(-1), ["error", "the setting arguments is not a JSON array of strings: --project /tmp"]);
});

test("an application that is not connected is an error and starts nothing", async () => {
  const s = surface(null, "[]");
  const { mountApplication: mount } = await import("../application-page.js");
  await mount(s.root, s.context, { application: "sketcher" });
  assert.deepEqual(s.sent, ["composition.create"]);
  assert.deepEqual(s.reports.at(-1), ["error", "the application sketcher is not connected"]);
});

test("@soksak/plugin-api exports the embed page for the surface of a connector plugin", async () => {
  const api = await import("../index.js");
  const { mountApplication } = await import("../application-page.js");
  assert.equal(api.mountApplication, mountApplication);
});
