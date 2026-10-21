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
  const onMessage = runtime.sidecar().on("probe-surface", (body) => bodies.push(body));
  const onFailure = runtime.sidecar().onFailure("probe-surface", (reason) => reasons.push(reason));
  assert.deepEqual(posted.at(-2), { sok: 1, id: 1, command: "runtime.sidecar.on", params: { id: "probe-surface" } });
  assert.deepEqual(posted.at(-1), { sok: 1, id: 2, command: "runtime.sidecar.onFailure", params: { id: "probe-surface" } });
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

test("runtime.log sends every record until the page tells the stored levels, then builds no fields of a level it does not store", async (t) => {
  const { posted, host } = setup(t);
  const { runtime } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  assert.equal(typeof runtime.log?.info, "function", "the view bridge has no runtime.log");
  let built = 0;
  const fields = () => { built += 1; return { n: built }; };
  runtime.log.info("saved", fields, { cids: ["b.1"] });
  assert.deepEqual(posted.slice(-2), [
    { sok: 1, id: 1, command: "runtime.log.levels", params: null },
    { sok: 1, id: 2, command: "runtime.log", params: { level: "info", event: "saved", fields: { n: 1 }, cids: ["b.1"] } },
  ]);
  host({ sok: 1, id: 1, result: ["error"] });
  host({ sok: 1, id: 2, result: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.log.enabled("info"), false);
  runtime.log.info("saved", fields);
  assert.equal(built, 1, "the fields of a level that is not stored were built");
  assert.equal(posted.length, 3);
  runtime.log.error("failed", { n: 2 });
  assert.deepEqual(posted.at(-1), { sok: 1, id: 3, command: "runtime.log", params: { level: "error", event: "failed", fields: { n: 2 } } });
  host({ sok: 1, event: "log.levels", data: ["error", "warn", "info"] });
  assert.equal(runtime.log.enabled("info"), true);
  assert.equal(posted.filter((message) => message.command === "runtime.log.levels").length, 1);
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
  host({ sok: 1, id: 1, result: null });
  host({ sok: 1, id: 2, error: { code: -32000, message: "log refused" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  host({ sok: 1, id: 3, error: { code: -32000, message: "error refused" } });
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
