// Checks the view channel over a jsdom window on sok://probe/. The injected document-start script (view-start.js) is loaded
// into the window before any page code, as the application injects it; the view module reads it through window.sokView.
// Nothing in the module uses a timer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createViewBridge, createViewChannel } from "../view.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUEUE_LIMIT = 256;

// The injected script runs in the realm of the window, so its objects carry other prototypes; the comparisons read plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const observeRejection = (promise) => { promise.catch(() => {}); return promise; };

/**
 * Creates a page on url with the sok-view handler, loads the injected script when script is true, and makes the page window the
 * global window of the view module for the test.
 */
function setup(t, { url = "sok://probe/", script = true } = {}) {
  const dom = new JSDOM("", { url, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const posted = [];
  dom.window.webkit = { messageHandlers: { "sok-view": { postMessage: (message) => posted.push(message) } } };
  if (script) dom.window.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
  // The view module reads the global window, which Node does not define; the test defines it for the test only.
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true, writable: true });
  t.after(() => { delete globalThis.window; });
  // A host message is a window message event whose source is the window; source replaces it for a foreign sender.
  const host = (data, source = dom.window) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source }));
  };
  return { posted, host };
}

test("the injected script posts the ready message with a document identifier at document start", (t) => {
  const { posted } = setup(t);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].event, "view.ready");
  assert.equal(posted[0].plugin, "probe");
  assert.match(posted[0].document, UUID);
});

test("each page has its own document identifier", (t) => {
  const first = setup(t);
  const second = setup(t);
  assert.notEqual(first.posted[0].document, second.posted[0].document);
});

test("the injected script exposes one global, sokView, whose attach is the only reader of host messages", (t) => {
  const { host } = setup(t);
  assert.deepEqual(Object.keys(globalThis.window.sokView), ["attach"]);
  assert.equal(Object.isFrozen(globalThis.window.sokView), true);
  host({ sok: 1, id: 1, result: "queued" });
  const received = [];
  globalThis.window.sokView.attach((message) => received.push(message));
  assert.deepEqual(received, [{ sok: 1, id: 1, result: "queued" }]);
});

test("host messages posted before createViewChannel() are delivered in order after the attach", (t) => {
  const { posted, host } = setup(t);
  host({ sok: 1, id: 1, result: "first" });
  host({ sok: 1, id: 2, result: "second" });
  const channel = createViewChannel({ handler: { postMessage: (message) => posted.push(message) } });
  const received = [];
  channel.onMessage((message) => received.push(message));
  assert.deepEqual(received, [{ sok: 1, id: 1, result: "first" }, { sok: 1, id: 2, result: "second" }]);
  host({ sok: 1, id: 3, result: "third" });
  assert.deepEqual(received.map((message) => message.id), [1, 2, 3]);
});

test("the 257th host message before the attach is reported through the handler and dropped", (t) => {
  const { posted, host } = setup(t);
  const before = posted.length;
  for (let id = 1; id <= QUEUE_LIMIT; id += 1) host({ sok: 1, id, result: id });
  assert.equal(posted.length, before, "no report while the queue holds its limit");
  host({ sok: 1, id: QUEUE_LIMIT + 1, result: "overflow" });
  assert.deepEqual(plain(posted.slice(before)), [
    { event: "view.error", plugin: "probe", reason: "queue full for probe" },
  ]);
  const received = [];
  globalThis.window.sokView.attach((message) => received.push(message.id));
  assert.deepEqual(received, Array.from({ length: QUEUE_LIMIT }, (_, index) => index + 1));
});

test("a host message without the sok marker is reported as an error and passed to no listener", (t) => {
  const { posted, host } = setup(t);
  const received = [];
  globalThis.window.sokView.attach((message) => received.push(message));
  const before = posted.length;
  host({ id: 1, result: "unmarked" });
  host({ sok: 2, id: 2, result: "wrong marker" });
  host("text");
  host(null);
  assert.deepEqual(plain(posted.slice(before)).map((message) => message.reason), Array(4).fill(
    "message without the sok marker for probe",
  ));
  assert.deepEqual(received, []);
});

test("a host message without the marker before the attach is reported and not queued", (t) => {
  const { posted, host } = setup(t);
  const before = posted.length;
  host({ id: 1, result: "unmarked" });
  assert.equal(posted.length, before + 1);
  const received = [];
  globalThis.window.sokView.attach((message) => received.push(message));
  assert.deepEqual(received, []);
});

test("a message from a source other than the window is reported as an error and passed to no listener", (t) => {
  const { posted, host } = setup(t);
  const received = [];
  globalThis.window.sokView.attach((message) => received.push(message));
  const before = posted.length;
  host({ sok: 1, id: 1, result: "foreign" }, { postMessage() {} });
  assert.deepEqual(plain(posted.slice(before)), [
    { event: "view.error", plugin: "probe", reason: "message from another source for probe" },
  ]);
  assert.deepEqual(received, []);
});

test("attach refuses a second listener and a value that is not a function", (t) => {
  setup(t);
  assert.throws(() => globalThis.window.sokView.attach("listener"), /attach requires a listener function/);
  globalThis.window.sokView.attach(() => {});
  assert.throws(() => globalThis.window.sokView.attach(() => {}), /already has a message listener/);
});

test("createViewChannel requires a handler with postMessage", (t) => {
  setup(t);
  assert.throws(() => createViewChannel({}), TypeError);
  assert.throws(() => createViewChannel({ handler: {} }), TypeError);
});

test("createViewChannel throws when the injected script is not loaded", (t) => {
  const { posted } = setup(t, { script: false });
  assert.throws(
    () => createViewChannel({ handler: { postMessage: (message) => posted.push(message) } }),
    /the view channel script is not loaded/,
  );
});

test("createViewBridge refuses a page that is not on sok://<plugin id>", (t) => {
  setup(t, { url: "https://example.test/" });
  assert.throws(
    () => createViewBridge({ handler: { postMessage() {} }, report: () => {} }),
    /requires a view page on sok:\/\/<plugin id>/,
  );
});

test("send posts each message through the handler", (t) => {
  const { posted } = setup(t);
  const channel = createViewChannel({ handler: { postMessage: (message) => posted.push(message) } });
  channel.send({ id: 1, command: "probe.run", params: { a: 1 } });
  assert.deepEqual(posted.at(-1), { id: 1, command: "probe.run", params: { a: 1 } });
});

test("createViewBridge sends a call with the sok marker and passes its reply to the caller", async (t) => {
  const { posted, host } = setup(t);
  const { calls } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const reply = calls.request("probe.run", { a: 1 });
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "probe.run", params: { a: 1 } });
  host({ sok: 1, id: 1, result: "done" });
  assert.equal(await reply, "done");
});

test("createViewBridge rejects a call with the error that the host forwards", async (t) => {
  const { host } = setup(t);
  const { calls } = createViewBridge({ handler: { postMessage: () => {} }, report: () => {} });
  const reply = calls.request("tab.state.read");
  host({ sok: 1, id: 1, error: { code: -32000, message: "tab.state is not declared" } });
  await assert.rejects(reply, { code: -32000, message: "tab.state is not declared" });
});

test("exposure.register sends the status or dom registration through the channel and resolves on the reply", async (t) => {
  const { posted, host } = setup(t);
  const { exposure } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const registered = exposure.register("status", "probe.state");
  assert.deepEqual(posted.at(-1), {
    sok: 1, id: 1, command: "runtime.native.call", params: { name: "registered", payload: { kind: "status", name: "probe.state" } },
  });
  host({ sok: 1, id: 1, result: null });
  assert.equal(await registered, null);
});

test("exposure.reply sends the reply of a forwarded exposure request with its id", async (t) => {
  const { posted, host } = setup(t);
  const { exposure } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const sent = exposure.reply(7, { result: { value: 1 } });
  assert.deepEqual(posted.at(-1), {
    sok: 1, id: 1, command: "runtime.native.call", params: { name: "exposureReply", payload: { id: 7, result: { value: 1 } } },
  });
  host({ sok: 1, id: 1, result: null });
  assert.equal(await sent, null);
});

test("createViewBridge sends a snapshot and takes its acknowledgement without a call error", (t) => {
  const { posted, host } = setup(t);
  const reports = [];
  const { snapshots } = createViewBridge({
    handler: { postMessage: (message) => posted.push(message) },
    report: (event) => reports.push(event),
  });
  snapshots.push("state", { count: 1 });
  assert.deepEqual(posted.at(-1), {
    event: "declared-ui.snapshot", plugin: "probe", status: "state", seq: 1, value: { count: 1 }, skipped: 0,
  });
  // The acknowledgement arrives as the view event declared-ui.snapshot.ack with {plugin, status, seq} as its data
  // (docs/spec/native-surfaces.md#view-surfaces, view events).
  host({ sok: 1, event: "declared-ui.snapshot.ack", data: { plugin: "probe", status: "state", seq: 1 } });
  snapshots.push("state", { count: 2 });
  assert.deepEqual(posted.at(-1), {
    event: "declared-ui.snapshot", plugin: "probe", status: "state", seq: 2, value: { count: 2 }, skipped: 0,
  });
  assert.deepEqual(reports, []);
});

test("createViewBridge answers the declared UI snapshot request with the value and its seq", (t) => {
  const { posted, host } = setup(t);
  const { snapshots } = createViewBridge({
    handler: { postMessage: (message) => posted.push(message) },
    report: () => {},
  });
  snapshots.push("state", { count: 1 });
  host({ sok: 1, id: 5, command: "declared-ui.snapshot.request", params: { status: "state" } });
  assert.deepEqual(posted.at(-1), { sok: 1, reply: 5, result: { seq: 1, value: { count: 1 } } });
});

test("the declared UI snapshot request for a status without a value replies seq 0 and value null", (t) => {
  const { posted, host } = setup(t);
  createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  host({ sok: 1, id: 6, command: "declared-ui.snapshot.request", params: { status: "other" } });
  assert.deepEqual(posted.at(-1), { sok: 1, reply: 6, result: { seq: 0, value: null } });
});

test("the declared UI snapshot request without a status name is refused", (t) => {
  const { posted, host } = setup(t);
  createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  host({ sok: 1, id: 7, command: "declared-ui.snapshot.request", params: {} });
  assert.deepEqual(posted.at(-1), {
    sok: 1, reply: 7, error: { code: -32602, message: "declared-ui.snapshot.request requires a status name" },
  });
});

test("runtime.native.on sends one subscription call per name and passes each host event of that name to its listener", async (t) => {
  const { posted, host } = setup(t);
  const seen = [];
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const off = runtime.native.on("probe.changed", (event) => seen.push(event));
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "runtime.native.on", params: { name: "probe.changed" } });
  host({ sok: 1, id: 1, result: null });
  const unsubscribe = await off;
  await runtime.native.on("probe.changed", () => {});
  assert.equal(posted.filter((message) => message.command === "runtime.native.on").length, 1);
  host({ sok: 1, event: "probe.changed", data: { count: 1 } });
  assert.deepEqual(seen, [{ count: 1 }]);
  unsubscribe();
  host({ sok: 1, event: "probe.changed", data: { count: 2 } });
  assert.deepEqual(seen, [{ count: 1 }]);
});

test("runtime.sidecar() delivers the messages and failures of its id only, with their body and reason", async (t) => {
  const { posted, host } = setup(t);
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const bodies = [];
  const reasons = [];
  const onMessage = runtime.sidecar("fixture-sidecar").on("probe-surface", (body) => bodies.push(body));
  const onFailure = runtime.sidecar("fixture-sidecar").onFailure("probe-surface", (reason) => reasons.push(reason));
  assert.deepEqual(posted.at(-2), { sok: 1, id: 1, command: "runtime.sidecar.on", params: { id: "probe-surface", sidecar: "fixture-sidecar" } });
  assert.deepEqual(posted.at(-1), { sok: 1, id: 2, command: "runtime.sidecar.onFailure", params: { id: "probe-surface", sidecar: "fixture-sidecar" } });
  host({ sok: 1, id: 1, result: null });
  host({ sok: 1, id: 2, result: null });
  await onMessage;
  await onFailure;
  host({ sok: 1, event: "sidecar.message", data: { id: "probe-surface", body: { n: 1 } } });
  host({ sok: 1, event: "sidecar.message", data: { id: "other-surface", body: { n: 2 } } });
  host({ sok: 1, event: "sidecar.failure", data: { id: "probe-surface", reason: "exited" } });
  assert.deepEqual(bodies, [{ n: 1 }]);
  assert.deepEqual(reasons, ["exited"]);
});

test("runtime.sidecar(name) sends to the named sidecar and its requests carry the name and the id", async (t) => {
  const { posted, host } = setup(t);
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  assert.throws(() => runtime.sidecar(), TypeError);
  assert.throws(() => runtime.sidecar(""), TypeError);
  const port = runtime.sidecar("fixture-sidecar");
  const sent = port.send("probe-surface", '{"operation":"list"}', ["c1"]);
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "runtime.sidecar.send", params: { id: "probe-surface", sidecar: "fixture-sidecar", body: '{"operation":"list"}', cids: ["c1"] } });
  host({ sok: 1, id: 1, result: null });
  assert.equal(await sent, null);
  const bodies = [];
  const onMessage = port.on("probe-surface", (body) => bodies.push(body));
  assert.deepEqual(posted.at(-1), { sok: 1, id: 2, command: "runtime.sidecar.on", params: { id: "probe-surface", sidecar: "fixture-sidecar" } });
  host({ sok: 1, id: 2, result: null });
  await onMessage;
  host({ sok: 1, event: "sidecar.message", data: { id: "probe-surface", body: { n: 1 } } });
  assert.deepEqual(bodies, [{ n: 1 }]);
});

test("runtime.theme gives the listener the last theme that the host sent, then each later theme", (t) => {
  const { host } = setup(t);
  const { runtime } = createViewBridge({ handler: { postMessage: () => {} }, report: () => {} });
  host({ sok: 1, event: "theme", data: { scheme: "dark", tokens: { bg: "#000" } } });
  const seen = [];
  runtime.theme((theme) => seen.push(theme));
  host({ sok: 1, event: "theme", data: { scheme: "light", tokens: { bg: "#fff" } } });
  assert.deepEqual(seen, [{ scheme: "dark", tokens: { bg: "#000" } }, { scheme: "light", tokens: { bg: "#fff" } }]);
});

test("runtime.textSize.read reads the scale of the surface and runtime.textSize.on subscribes once", async (t) => {
  const { posted, host } = setup(t);
  const seen = [];
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const read = runtime.textSize.read();
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "runtime.textSize.read", params: null });
  host({ sok: 1, id: 1, result: 1.5 });
  assert.equal(await read, 1.5);
  const off = runtime.textSize.on((factor) => seen.push(factor));
  assert.deepEqual(posted.at(-1), { sok: 1, id: 2, command: "runtime.textSize.on", params: null });
  host({ sok: 1, id: 2, result: null });
  await off;
  await runtime.textSize.on(() => {});
  assert.equal(posted.filter((message) => message.command === "runtime.textSize.on").length, 1);
  host({ sok: 1, event: "textSize", data: 1.5 });
  assert.deepEqual(seen, [1.5]);
  (await off)();
  host({ sok: 1, event: "textSize", data: 2 });
  assert.deepEqual(seen, [1.5]);
});

test("runtime.settings.read reads the settings of the plugin and runtime.settings.on subscribes once", async (t) => {
  const { posted, host } = setup(t);
  const seen = [];
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const read = runtime.settings.read();
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "runtime.settings.read", params: null });
  host({ sok: 1, id: 1, result: { home: "sok://core/start" } });
  assert.deepEqual(await read, { home: "sok://core/start" });
  const off = runtime.settings.on((values) => seen.push(values));
  assert.deepEqual(posted.at(-1), { sok: 1, id: 2, command: "runtime.settings.on", params: null });
  host({ sok: 1, id: 2, result: null });
  await off;
  await runtime.settings.on(() => {});
  assert.equal(posted.filter((message) => message.command === "runtime.settings.on").length, 1);
  host({ sok: 1, event: "settings", data: { home: "sok://core/start" } });
  assert.deepEqual(seen, [{ home: "sok://core/start" }]);
  (await off)();
  host({ sok: 1, event: "settings", data: { home: "" } });
  assert.deepEqual(seen, [{ home: "sok://core/start" }]);
});

test("runtime.error sends the error line of the view as the call runtime.error and resolves on the reply", async (t) => {
  const { posted, host } = setup(t);
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  assert.equal(typeof runtime.error, "function", "the view bridge has no runtime.error");
  const sent = runtime.error("save", "disk full");
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "runtime.error", params: { where: "save", text: "disk full" } });
  host({ sok: 1, id: 1, result: null });
  assert.equal(await sent, undefined);
});

test("contributions(point) returns the connected items of the point, and fail(reason) makes one invalid through the page", async (t) => {
  const { posted, host } = setup(t);
  const bridge = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  assert.equal(typeof bridge.contributions, "function", "the view bridge has no contributions");
  const read = bridge.contributions("language");
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "runtime.contributions", params: { point: "language" } });
  host({ sok: 1, id: 1, result: [{ plugin: "one", index: 0, item: { name: "one" }, module: "sok://core/modules/one.js" }] });
  const items = await read;
  assert.deepEqual(items.map(({ plugin, index, item, module }) => ({ plugin, index, item, module })),
    [{ plugin: "one", index: 0, item: { name: "one" }, module: "sok://core/modules/one.js" }]);
  const failing = items[0].fail(new Error("extend is not a function"));
  assert.deepEqual(posted.at(-1), { sok: 1, id: 2, command: "runtime.contributions.fail",
    params: { point: "language", plugin: "one", index: 0, reason: "extend is not a function" } });
  host({ sok: 1, id: 2, result: null });
  assert.equal(await failing, undefined);
});

test("the view bridge has no level query: runtime.log sends each record and asks no stored levels", async (t) => {
  // The writer of the event log decides whether a record is stored, so the page has no level query (docs/spec/native-surfaces.md).
  const { posted, host } = setup(t);
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  assert.equal(runtime.log.enabled, undefined, "the view bridge still exports runtime.log.enabled");
  let built = 0;
  runtime.log.info("saved", () => { built += 1; return { n: built }; }, { cids: ["b.1"] });
  assert.deepEqual(posted.filter(({ command }) => command !== undefined), [{ sok: 1, id: 1, command: "runtime.log", params: { level: "info", event: "saved", fields: { n: 1 }, cids: ["b.1"] } }]);
  host({ sok: 1, id: 1, result: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(built, 1, "the builder of a record was not run once");
});

/** Dispatches a cancelable keydown on the window of the view and returns the event. */
const keydown = (init) => {
  const event = new globalThis.window.KeyboardEvent("keydown", { cancelable: true, ...init });
  globalThis.window.dispatchEvent(event);
  return event;
};

test("the bridge sends no call for a key and has no shortcut table", (t) => {
  const { posted } = setup(t);
  const bridge = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const before = posted.length;
  // A workbench key, a view key and an ordinary key keep their default action: the view decides, and the bridge forwards nothing.
  for (const init of [{ key: "j", ctrlKey: true }, { key: "Escape" }, { key: "a" }, { key: "k", metaKey: true }]) {
    assert.equal(keydown(init).defaultPrevented, false, `the bridge prevented ${JSON.stringify(init)}`);
  }
  assert.equal(posted.length, before, "the bridge sent a call for a key");
  assert.equal(bridge.shortcuts, undefined, "the view bridge still has a shortcut table");
});

test("an event that no listener has is passed to no call layer and reports nothing", (t) => {
  const { host } = setup(t);
  const reports = [];
  createViewBridge({ handler: { postMessage: () => {} }, report: (event) => reports.push(event) });
  host({ sok: 1, event: "probe.unlistened", data: 1 });
  assert.deepEqual(reports, []);
});

test("commands.register sends the registration call, and the page reply resolves it", async (t) => {
  const { posted, host } = setup(t);
  const { commands } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const registered = commands.register("probe.run", () => null);
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "runtime.command.register", params: { name: "probe.run" } });
  host({ sok: 1, id: 1, result: null });
  assert.equal(await registered, undefined);
});

test("a request of the page runs the registered command and replies with its result on the reply field", async (t) => {
  const { posted, host } = setup(t);
  const { commands } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const calls = [];
  commands.register("probe.run", (params) => { calls.push(params); return { n: params.a + 1 }; });
  host({ sok: 1, id: 1, result: null });
  await new Promise((resolve) => setImmediate(resolve));
  host({ sok: 1, id: 9, command: "probe.run", params: { a: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ a: 1 }]);
  assert.deepEqual(posted.at(-1), { sok: 1, reply: 9, result: { n: 2 } });
});

test("a request for a command the view did not register replies with the unregistered error", async (t) => {
  const { posted, host } = setup(t);
  createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  host({ sok: 1, id: 10, command: "probe.other", params: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted.at(-1), { sok: 1, reply: 10, error: { code: 1002, message: "view command probe.other is not registered" } });
});

test("a handler that throws replies with its message as the error of the reply", async (t) => {
  const { posted, host } = setup(t);
  const { commands } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  commands.register("probe.fail", () => { throw new Error("boom"); });
  host({ sok: 1, id: 1, result: null });
  host({ sok: 1, id: 11, command: "probe.fail", params: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted.at(-1), { sok: 1, reply: 11, error: { code: -32000, message: "boom" } });
});

test("a registration that the page refuses leaves no handler, so a request for it is unregistered", async (t) => {
  const { posted, host } = setup(t);
  const { commands } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const refused = commands.register("other.run", () => null);
  host({ sok: 1, id: 1, error: { code: 1002, message: "owner probe has not registered command other.run" } });
  await assert.rejects(refused, { message: "owner probe has not registered command other.run" });
  host({ sok: 1, id: 12, command: "other.run", params: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted.at(-1), { sok: 1, reply: 12, error: { code: 1002, message: "view command other.run is not registered" } });
});

test("a view record that the host refuses is reported, and so is its refused error line", async (t) => {
  const { posted, host } = setup(t);
  const reports = [];
  const { runtime } = createViewBridge({
    handler: { postMessage: (message) => posted.push(message) },
    report: (event) => reports.push(event),
  });
  runtime.log.info("saved", { n: 1 });
  host({ sok: 1, id: 1, error: { code: -32000, message: "log refused" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  host({ sok: 1, id: 2, error: { code: -32000, message: "error refused" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The report also receives the counts and losses of the calls, which have no where.
  const refused = reports.filter((event) => event.where !== undefined);
  assert.equal(refused.length, 1, "the refused record is reported once, with its refused error line");
  assert.equal(refused[0].where, "log plugin.probe.saved");
  assert.equal(refused[0].text, "log refused");
  assert.equal(refused[0].error?.message, "error refused");
});

test("runtime.command sends a command name through the view call route and resolves on the reply", async (t) => {
  const { posted, host } = setup(t);
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  assert.equal(typeof runtime.command, "function", "the view bridge has no runtime.command");
  const sent = runtime.command("core.picker.close", {});
  assert.deepEqual(posted.at(-1), { sok: 1, id: 1, command: "core.picker.close", params: {} });
  host({ sok: 1, id: 1, result: "closed" });
  assert.equal(await sent, "closed");
  assert.throws(() => runtime.command(""), /runtime\.command requires a non-empty name/);

});

/**
 * Prepares a view page with one region element and a handler that answers each call of the view at once with the reply of its
 * command in replies, or null. The window gets the observers and the viewport that the composition controller reads.
 */
function compositionSetup(t, replies) {
  const { posted, host } = setup(t);
  const view = globalThis.window;
  view.document.body.innerHTML = '<div id="doc"></div><div id="picture"></div>';
  view.ResizeObserver = class { observe() {} disconnect() {} };
  view.requestAnimationFrame = () => 1;
  view.cancelAnimationFrame = () => {};
  view.visualViewport = { width: 800, height: 600 };
  const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
  view.document.getElementById("doc").getBoundingClientRect = () => rect(10, 20, 300, 200);
  view.document.getElementById("picture").getBoundingClientRect = () => rect(320, 20, 400, 400);
  const handler = {
    postMessage: (message) => {
      posted.push(message);
      if (typeof message.command !== "string") return;
      const reply = replies[message.command];
      queueMicrotask(() => host({ sok: 1, id: message.id, result: typeof reply === "function" ? reply(message.params) : reply ?? null }));
    },
  };
  return { posted, host, view, handler };
}

const VIEW_DECLARATION = {
  kind: "view",
  regions: [
    { name: "doc", kind: "document", input: "native" },
    { name: "picture", kind: "image", sidecar: "@probe/sidecar", input: "dom" },
  ],
  overlays: [],
};

test("composition.create of a view attaches its declared regions and places one snapshot through view calls", async (t) => {
  const { posted, host, view, handler } = compositionSetup(t, {
    "composition.declaration": VIEW_DECLARATION,
    "document.attach": { history: false },
  });
  const bridge = createViewBridge({ handler, report: () => {} });
  assert.equal(typeof bridge.composition?.create, "function", "the view bridge has a composition");
  const composition = await bridge.composition.create({
    regions: { doc: view.document.getElementById("doc"), picture: view.document.getElementById("picture") },
    overlays: {},
  });
  const calls = posted.filter((message) => typeof message.command === "string").map(({ command, params }) => ({ command, params }));
  assert.deepEqual(calls, [
    { command: "composition.declaration", params: null },
    { command: "document.attach", params: { name: "doc" } },
    { command: "runtime.native.on", params: { name: "document-state" } },
    { command: "runtime.native.on", params: { name: "document-message" } },
    { command: "runtime.native.on", params: { name: "document-stream" } },
    { command: "image.attach", params: { name: "picture", sidecar: "@probe/sidecar" } },
    { command: "runtime.native.on", params: { name: "image-event" } },
    { command: "composition.place", params: {
      regions: [
        { name: "doc", left: 10, top: 20, right: 490, bottom: 380, visible: true },
        { name: "picture", left: 320, top: 20, right: 80, bottom: 180, visible: true },
      ],
      overlays: [],
    } },
  ]);
  // The region handles send their operations as view calls, and the region events arrive through runtime.native.on.
  const doc = composition.region("doc");
  const states = [];
  doc.onState((state) => states.push(state));
  host({ sok: 1, event: "document-state", data: { surface: "probe-surface", document: "doc", state: { url: "https://example.test/" } } });
  host({ sok: 1, event: "document-state", data: { surface: "probe-surface", document: "other", state: { url: "https://other.test/" } } });
  assert.deepEqual(plain(states), [{ url: "https://example.test/" }]);
  await doc.load("https://example.test/");
  await composition.region("picture").setCaret({ x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(posted.slice(-2).map(({ command, params }) => ({ command, params })), [
    { command: "document.load", params: { name: "doc", url: "https://example.test/" } },
    { command: "image.caret", params: { name: "picture", x: 1, y: 2, width: 3, height: 4 } },
  ]);
  await composition.dispose();
  assert.deepEqual(posted.slice(-2).map(({ command, params }) => ({ command, params })).sort((a, b) => a.command.localeCompare(b.command)), [
    { command: "document.detach", params: { name: "doc" } },
    { command: "image.detach", params: { name: "picture" } },
  ]);
});

test("composition.create of a view refuses elements that do not match its declaration and attaches nothing", async (t) => {
  const { posted, view, handler } = compositionSetup(t, { "composition.declaration": VIEW_DECLARATION });
  const bridge = createViewBridge({ handler, report: () => {} });
  assert.equal(typeof bridge.composition?.create, "function", "the view bridge has a composition");
  await assert.rejects(
    bridge.composition.create({ regions: { doc: view.document.getElementById("doc") }, overlays: {} }),
    { message: "composition regions must exactly match the surface declaration (expected doc, picture)" },
  );
  assert.deepEqual(posted.filter((message) => typeof message.command === "string").map((message) => message.command), ["composition.declaration"]);
});

// Published producer-side bridge vectors run against createViewBridge, not the consumer fixture.
const BRIDGE_CONTRACT = JSON.parse(readFileSync(new URL("../contract/view-bridge.json", import.meta.url), "utf8"));
const BRIDGE_ACTIONS = {
  "view.bridge.ready-and-request-reply": ["create", "request", "host-reply"],
  "view.bridge.events-delivered-in-order": ["subscribe", "host-event", "host-event"],
  "view.bridge.refuses-malformed-host-message": ["create", "host-malformed"],
  "view.bridge.refuses-unsupported-page": ["create"],
  "view.bridge.tab-state-read-write": ["create", "request", "host-reply", "request", "host-reply"],
  "view.bridge.sidecar-send": ["create", "sidecar-send", "host-reply"],
  "view.bridge.sidecar-subscriptions": ["create", "sidecar-subscribe", "host-reply", "sidecar-subscribe", "host-reply", "host-event", "host-event", "host-event"],
  "view.bridge.runtime-log-without-level-query": ["create", "log", "host-reply", "log-builder", "log", "host-reply", "host-reply"],
};
const OPEN_CALL_COUNTS = {
  "view.bridge.ready-and-request-reply": [1, 0],
  "view.bridge.events-delivered-in-order": [],
  "view.bridge.refuses-malformed-host-message": [],
  "view.bridge.tab-state-read-write": [1, 0, 1, 0],
  "view.bridge.sidecar-send": [1, 0],
  "view.bridge.sidecar-subscriptions": [1, 0, 1, 0],
  "view.bridge.runtime-log-without-level-query": [1, 0, 1, 2, 1, 0],
};
function assertOpenCallSequence(reports, plugin, expected) {
  const updates = reports.filter(({ kind }) => kind === "open-calls");
  assert.deepEqual(updates.map(({ count }) => count), expected);
  for (const update of updates) {
    assert.equal(update.plugin, plugin);
    if (update.count === 0) assert.equal(update.oldestStartedAt, null);
    else assert.ok(Number.isFinite(update.oldestStartedAt));
  }
}
function validateBridgeCases(cases) {
  assert.ok(Array.isArray(cases) && cases.length > 0, "view bridge contract must publish cases");
  const ids = cases.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "bridge case ids must be unique");
  assert.deepEqual([...ids].sort(), Object.keys(BRIDGE_ACTIONS).sort(), "all required bridge cases must be present");
  const hostEvents = {
    "view.bridge.events-delivered-in-order": ["theme"],
    "view.bridge.sidecar-subscriptions": ["sidecar.message", "sidecar.failure"],
  };
  for (const item of cases) {
    assert.deepEqual(item.steps.map(({ action }) => action), BRIDGE_ACTIONS[item.id], item.id + " ordered actions");
    for (const step of item.steps) {
      if (step.action === "host-event") {
        assert.equal(step.input?.sok, 1, item.id + " host-event input must carry sok: 1");
        assert.ok(hostEvents[item.id]?.includes(step.input.event), item.id + " has unsupported host-event " + step.input.event);
      }
      if (step.action === "sidecar-subscribe") {
        assert.ok(["message", "failure"].includes(step.input?.kind), item.id + " has unsupported subscription kind: " + step.input?.kind);
      }
    }
  }
  const subscriptionKinds = cases.find(({ id }) => id === "view.bridge.sidecar-subscriptions").steps
    .filter(({ action }) => action === "sidecar-subscribe").map(({ input }) => input.kind);
  assert.deepEqual(subscriptionKinds, ["message", "failure"], "view.bridge.sidecar-subscriptions subscription kinds");
  const refusal = cases.find(({ id }) => id === "view.bridge.refuses-unsupported-page");
  assert.equal(refusal.steps[0].output.throws, "view channel requires a view page on sok://<plugin id>, got https://example.test/");
}
test("view bridge contract validation rejects empty, missing, and shortened cases", () => {
  assert.throws(() => validateBridgeCases([]), /must publish cases/);
  assert.throws(() => validateBridgeCases(BRIDGE_CONTRACT.cases.slice(1)), /all required bridge cases/);
  const shortened = structuredClone(BRIDGE_CONTRACT.cases);
  shortened.find(({ id }) => id === "view.bridge.refuses-unsupported-page").steps[0].output.throws = "view channel requires a view page on sok://<plugin id>";
  assert.throws(() => validateBridgeCases(shortened), /strictly equal/);
  const missingMarker = structuredClone(BRIDGE_CONTRACT.cases);
  delete missingMarker.find(({ id }) => id === "view.bridge.events-delivered-in-order").steps[1].input.sok;
  assert.throws(() => validateBridgeCases(missingMarker), /host-event input must carry sok: 1/);
  const unexpectedAction = structuredClone(BRIDGE_CONTRACT.cases);
  unexpectedAction.find(({ id }) => id === "view.bridge.sidecar-send").steps.splice(2, 0, { action: "ignored" });
  assert.throws(() => validateBridgeCases(unexpectedAction), /ordered actions/);
  const unknownSubscription = structuredClone(BRIDGE_CONTRACT.cases);
  unknownSubscription.find(({ id }) => id === "view.bridge.sidecar-subscriptions").steps[1].input.kind = "unknown";
  assert.throws(() => validateBridgeCases(unknownSubscription), /unsupported subscription kind/);
  const missingFailureSubscription = structuredClone(BRIDGE_CONTRACT.cases);
  missingFailureSubscription.find(({ id }) => id === "view.bridge.sidecar-subscriptions").steps[3].input.kind = "message";
  assert.throws(() => validateBridgeCases(missingFailureSubscription), /subscription kinds/);
  const unknownEvent = structuredClone(BRIDGE_CONTRACT.cases);
  unknownEvent.find(({ id }) => id === "view.bridge.events-delivered-in-order").steps[1].input.event = "unlisted.event";
  assert.throws(() => validateBridgeCases(unknownEvent), /unsupported host-event/);
});
test("published view bridge cases match calls, replies, events, and refusals", async (t) => {
  validateBridgeCases(BRIDGE_CONTRACT.cases);
  for (const item of BRIDGE_CONTRACT.cases) {
    await t.test(item.id, async (subtest) => {
      if (item.id === "view.bridge.refuses-unsupported-page") {
        setup(subtest, { url: item.steps[0].input.url });
        let actual;
        try { createViewBridge({ handler: { postMessage() {} }, report() {} }); } catch (error) { actual = error; }
        assert.ok(actual, "unsupported page must be refused");
        assert.equal(actual.message, item.steps[0].output.throws);
        return;
      }
      const create = item.steps.find(({ action }) => action === "create");
      const { posted, host } = setup(subtest, { url: create?.input?.url ?? "sok://probe/" });
      const reports = [];
      const bridge = createViewBridge({ handler: { postMessage: (message) => posted.push(plain(message)) }, report: (event) => reports.push(event) });
      subtest.after(async () => {
        bridge.calls.peerLost("surface-closed");
        await new Promise((resolve) => setImmediate(resolve));
        if (bridge.calls.openCalls().count > 0) bridge.calls.peerLost("surface-closed");
        bridge.calls.close();
      });
      const readyStep = item.steps.find(({ action }) => action === "create");
      if (readyStep) {
        assert.equal(posted[0]?.event === "view.ready", readyStep.output.ready);
        if (readyStep.output.plugin !== undefined) assert.equal(posted[0]?.plugin, readyStep.output.plugin);
      }
      if (item.id === "view.bridge.ready-and-request-reply") {
        assert.equal(posted[0]?.event === "view.ready", item.steps[0].output.ready);
        const reply = observeRejection(bridge.calls.request(item.steps[1].input.command, item.steps[1].input.params));
        assert.deepEqual(posted.at(-1), item.steps[1].output);
        host(item.steps[2].input);
        assert.equal(await reply, item.steps[2].output);
        assert.equal(bridge.calls.openCalls().count, 0);
      } else if (item.id === "view.bridge.refuses-malformed-host-message") {
        assert.equal(posted[0]?.event === "view.ready", item.steps[0].output.ready);
        const before = posted.length;
        host(item.steps[1].input);
        assert.deepEqual(plain(posted.slice(before)), [item.steps[1].output]);
      } else if (item.id === "view.bridge.tab-state-read-write") {
        const pending = [];
        for (const step of item.steps.slice(1)) {
          if (step.action === "request") {
            pending.push(observeRejection(bridge.calls.request(step.input.command, step.input.params)));
            assert.deepEqual(plain(posted.at(-1)), step.output);
          } else if (step.action === "host-reply") {
            host(step.input);
            assert.deepEqual(await pending.shift(), step.output);
            assert.equal(bridge.calls.openCalls().count, pending.length);
          }
        }
        assert.equal(pending.length, 0);
      } else if (item.id === "view.bridge.sidecar-send") {
        const steps = item.steps.slice(1);
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index];
          if (step.action !== "sidecar-send") throw new Error("unsupported sidecar-send action " + step.action);
          const replyStep = steps[index + 1];
          assert.equal(replyStep.action, "host-reply");
          const pending = observeRejection(bridge.runtime.sidecar(step.input.sidecar).send(step.input.id, step.input.body, step.input.cids));
          let mismatch;
          try { assert.deepEqual(plain(posted.at(-1)), step.output); } catch (error) { mismatch = error; }
          host(replyStep.input);
          try { assert.deepEqual(await pending, replyStep.output); } catch (error) { mismatch ??= error; }
          assert.equal(bridge.calls.openCalls().count, 0);
          index += 1;
          if (mismatch) throw mismatch;
        }
      } else if (item.id === "view.bridge.sidecar-subscriptions") {
        const received = { messages: [], failures: [] };
        const steps = item.steps.slice(1);
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index];
          if (step.action === "sidecar-subscribe") {
            const replyStep = steps[index + 1];
            assert.equal(replyStep.action, "host-reply");
            const port = bridge.runtime.sidecar(step.input.sidecar);
            let subscribe;
            if (step.input.kind === "message") subscribe = () => port.on(step.input.id, (body) => received.messages.push(body));
            else if (step.input.kind === "failure") subscribe = () => port.onFailure(step.input.id, (reason) => received.failures.push(reason));
            else throw new Error("unsupported sidecar subscription kind " + step.input.kind);
            const subscription = observeRejection(subscribe());
            let mismatch;
            try { assert.deepEqual(plain(posted.at(-1)), step.output); } catch (error) { mismatch = error; }
            host(replyStep.input);
            try { assert.equal(typeof await subscription, "function"); } catch (error) { mismatch ??= error; }
            assert.equal(bridge.calls.openCalls().count, 0);
            index += 1;
            if (mismatch) throw mismatch;
          } else if (step.action === "host-event") {
            host(step.input);
            assert.deepEqual(received, step.output);
          } else {
            throw new Error("unsupported sidecar-subscriptions action " + step.action);
          }
        }
      } else if (item.id === "view.bridge.runtime-log-without-level-query") {
        assert.equal(globalThis.window.location.host, "probe");
        const { runtime } = bridge;
        for (const step of item.steps.slice(1)) {
          if (step.action === "log") {
            const before = posted.length;
            const fields = () => ({ ...step.input.fields });
            runtime.log[step.input.level](step.input.event, fields, step.input.cids === undefined ? undefined : { cids: step.input.cids });
            assert.deepEqual(plain(posted.slice(before)), step.output);
          } else if (step.action === "host-reply") {
            host(step.input);
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepEqual(reports.filter(({ kind }) => kind !== "open-calls"), []);
          } else if (step.action === "log-builder") {
            const before = posted.length;
            let built = false;
            runtime.log[step.input.level](step.input.event, () => { built = true; return step.input.fields; });
            assert.deepEqual({ calls: posted.length - before, built }, step.output);
          } else {
            throw new Error("unsupported runtime-log case action " + step.action);
          }
        }
      } else {
        const received = [];
        assert.equal(item.steps[0].input, "theme");
        const subscription = bridge.runtime.theme((value) => received.push(value));
        for (const step of item.steps.slice(1)) {
          host(step.input);
          assert.equal(received.at(-1), step.output);
        }
        assert.deepEqual(received, item.steps.slice(1).map((step) => step.output));
        await subscription.dispose;
      }
      assertOpenCallSequence(reports, globalThis.window.location.host, OPEN_CALL_COUNTS[item.id]);
    });
  }
});
