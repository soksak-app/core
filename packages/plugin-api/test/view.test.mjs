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

test("createViewBridge sends a call and passes its reply to the caller", async (t) => {
  const { posted, host } = setup(t);
  const { calls } = createViewBridge({ handler: { postMessage: (message) => posted.push(message) }, report: () => {} });
  const reply = calls.request("probe.run", { a: 1 });
  assert.deepEqual(posted.at(-1), { id: 1, command: "probe.run", params: { a: 1 } });
  host({ sok: 1, id: 1, result: "done" });
  assert.equal(await reply, "done");
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
    event: "declared-ui.snapshot", plugin: "probe", status: "state", seq: 1, value: { count: 1 },
  });
  host({ sok: 1, event: "declared-ui.snapshot.ack", plugin: "probe", status: "state", seq: 1 });
  snapshots.push("state", { count: 2 });
  assert.deepEqual(posted.at(-1), {
    event: "declared-ui.snapshot", plugin: "probe", status: "state", seq: 2, value: { count: 2 },
  });
  assert.deepEqual(reports, []);
});
