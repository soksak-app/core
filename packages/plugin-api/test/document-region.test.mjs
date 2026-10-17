// Checks that the document region reports the viewport margins of the element, keeps the call order and receives only its own state.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { attachRegion, regionInsets } from "../document-region.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A window in which the rectangle of an element can be set. ResizeObserver records the observed element and the callback. */
function fixture() {
  const { window } = new JSDOM("<body><div id=outer><div id=region></div></div></body>", { url: "https://example.test/" });
  const observed = [];
  const callbacks = [];
  window.ResizeObserver = class {
    constructor(fn) { callbacks.push(fn); this.disconnected = false; }
    observe(node) { observed.push(node); }
    disconnect() { this.disconnected = true; callbacks.length = 0; }
  };
  // The observation starts at an animation frame. frame() runs the waiting callback.
  const frames = [];
  window.requestAnimationFrame = (fn) => frames.push(fn);
  window.cancelAnimationFrame = () => {};
  const reported = [];
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  window.visualViewport = { get width() { return window.innerWidth; }, get height() { return window.innerHeight; } };
  const element = window.document.getElementById("region");
  let rect = { left: 10, top: 40, right: 510, bottom: 440, width: 500, height: 400 };
  element.getBoundingClientRect = () => rect;
  return {
    window, element, observed,
    resize: (next) => { rect = next; for (const fn of [...callbacks]) fn([]); },
    callbacks,
    reported,
    report: (line) => { reported.push(line); },
    frame: () => { for (const fn of frames.splice(0)) fn(); },
  };
}

function port() {
  const calls = [];
  const port = {};
  let receive = null;
  let stopped = false;
  let release;
  const attached = new Promise((resolve) => { release = resolve; });
  return Object.assign(port, {
    calls, attached, release,
    send: (document, state) => receive(document, state),
    stopped: () => stopped,
    attach: (name) => { calls.push(["attach", name]); return attached; },
    place: async (name, insets, visible) => { calls.push(["place", name, insets, visible]); },
    load: async (name, url) => { calls.push(["load", name, url]); },
    go: async (name, action, offset) => { calls.push(offset === undefined ? ["go", name, action] : ["go", name, action, offset]); return true; },
    detach: async (name) => { calls.push(["detach", name]); },
    onState: (fn) => { receive = fn; return Promise.resolve(() => { stopped = true; }); },
    post: async (name, message) => { calls.push(["post", name, message]); },
    onMessage: (fn) => { port.message = fn; return Promise.resolve(() => {}); },
    onStream: (fn) => { port.stream = fn; return Promise.resolve(() => {}); },
  });
}

test("regionInsets measures the element against the viewport", () => {
  const f = fixture();
  assert.deepEqual(regionInsets(f.element, f.window),
    { insets: { left: 10, top: 40, right: 290, bottom: 160 }, visible: true });
  f.element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  assert.equal(regionInsets(f.element, f.window).visible, false);
});

test("fractional viewport sizes do not create native region insets", () => {
  const f = fixture();
  f.window.visualViewport = { width: 597.5, height: 286.5 };
  Object.defineProperty(f.window, "innerWidth", { value: 597 });
  Object.defineProperty(f.window, "innerHeight", { value: 286 });
  f.resize({ left: 0, top: 0, right: 597.5, bottom: 286.5, width: 597.5, height: 286.5 });
  assert.deepEqual(regionInsets(f.element, f.window).insets,
    { left: 0, top: 0, right: 0, bottom: 0 });
});

test("calls wait for attach and run in order", async () => {
  const f = fixture();
  const p = port();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  const loaded = region.load("http://127.0.0.1/");
  const went = region.back();
  await settle();
  assert.deepEqual(p.calls, [["attach", "page"]]);
  p.release();
  await loaded;
  assert.equal(await went, true);
  assert.deepEqual(p.calls, [
    ["attach", "page"],
    ["place", "page", { left: 10, top: 40, right: 290, bottom: 160 }, true],
    ["load", "page", "http://127.0.0.1/"],
    ["go", "page", "back"],
  ]);
});

test("layout changes place the region once per change", async () => {
  const f = fixture();
  const p = port();
  p.release();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  // The observation starts at the next animation frame (AGENTS.md).
  assert.deepEqual(f.observed, [], "an element was observed before the next animation frame");
  f.frame();
  assert.deepEqual(f.observed.map((node) => node.id || node.tagName), ["region", "outer", "BODY", "HTML"]);
  f.resize({ left: 20, top: 40, right: 420, bottom: 340, width: 400, height: 300 });
  f.resize({ left: 20, top: 40, right: 420, bottom: 340, width: 400, height: 300 });
  f.window.dispatchEvent(new f.window.Event("resize"));
  Object.defineProperty(f.window, "innerWidth", { value: 700, configurable: true });
  f.window.dispatchEvent(new f.window.Event("resize"));
  await region.load("https://example.test/");
  const places = p.calls.filter(([kind]) => kind === "place").map((call) => call[2]);
  assert.deepEqual(places, [
    { left: 10, top: 40, right: 290, bottom: 160 },
    { left: 20, top: 40, right: 380, bottom: 260 },
    { left: 20, top: 40, right: 280, bottom: 260 },
  ]);
});

test("state reaches only the named region", async () => {
  const f = fixture();
  const p = port();
  p.release();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  const seen = [];
  region.onState((state) => seen.push(state));
  p.send("other", { url: "https://other.test/" });
  p.send("page", { url: "https://example.test/" });
  assert.deepEqual(seen, [{ url: "https://example.test/" }]);
  assert.deepEqual(region.state, { url: "https://example.test/" });
});

test("detach stops observation and rejects later calls", async () => {
  const f = fixture();
  const p = port();
  p.release();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  await region.detach();
  await settle();
  assert.equal(p.calls.at(-1)[0], "detach");
  assert.equal(f.callbacks.length, 0);
  assert.equal(p.stopped(), true);
  await assert.rejects(region.load("https://example.test/"), /detached/);
  const count = p.calls.length;
  f.window.dispatchEvent(new f.window.Event("resize"));
  assert.equal(p.calls.length, count);
});

test("invalid names and actions are rejected", async () => {
  const f = fixture();
  const p = port();
  assert.throws(() => attachRegion(p, f.element, "Page", f.window, { report: f.report }), /invalid document name/);
  p.release();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  await assert.rejects(region.go("home"), /unknown document action/);
  await assert.rejects(region.entry(0), /invalid history offset/);
  await assert.rejects(region.entry(1.5), /invalid history offset/);
});

test("a history entry is sent as the entry action with its offset", async () => {
  const f = fixture();
  const p = port();
  p.release();
  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  assert.equal(await region.entry(-2), true);
  assert.deepEqual(p.calls.at(-1), ["go", "page", "entry", -2]);
});

test("visibility: display:none element is hidden", () => {
  const f = fixture();
  f.element.style.display = "none";
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, false, "display:none element is not visible");
});

test("visibility: visibility:hidden element is hidden", () => {
  const f = fixture();
  f.element.style.visibility = "hidden";
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, false, "visibility:hidden element is not visible");
});

test("visibility: ancestor with display:none hides element", () => {
  const f = fixture();
  const outer = f.window.document.getElementById("outer");
  outer.style.display = "none";
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, false, "element is hidden when ancestor has display:none");
});

test("visibility: normal element is visible", () => {
  const f = fixture();
  // The element has the width and height received from the mock getBoundingClientRect.
  const insets = regionInsets(f.element, f.window);
  assert.equal(insets.visible, true, "normal element with size is visible");
});

test("visibility: propagates through attachRegion place", async () => {
  const f = fixture();
  const p = port();
  p.release();

  const region = attachRegion(p, f.element, "page", f.window, { report: f.report });
  await settle();

  // Check that the first place call has visible=true.
  const placeCallsBefore = p.calls.filter(([kind]) => kind === "place");
  assert.equal(placeCallsBefore.length, 1, "initial place call");
  assert.equal(placeCallsBefore[0][3], true, "initial visible is true");

  // Hide the element.
  f.element.style.display = "none";
  f.resize({ left: 10, top: 40, right: 510, bottom: 440, width: 500, height: 400 });
  await settle();

  // Check that the new place call has visible=false.
  const placeCallsAfter = p.calls.filter(([kind]) => kind === "place");
  assert.equal(placeCallsAfter.length, 2, "place called again on visibility change");
  assert.equal(placeCallsAfter[1][3], false, "visible is false when display:none");
});

test("a document region requires a report for its failures", () => {
  const f = fixture();
  assert.throws(() => attachRegion(port(), f.element, "page", f.window), /requires a report/);
});

test("a placement that fails while observing is reported as an error", async () => {
  const f = fixture();
  const p = port();
  p.release();
  p.place = async () => { throw new Error("host refused the placement"); };
  attachRegion(p, f.element, "page", f.window, { report: f.report });
  f.frame();
  f.resize({ left: 20, top: 40, right: 420, bottom: 340, width: 400, height: 300 });
  await settle();
  assert.ok(f.reported.some((line) => line === "document page place: host refused the placement"), JSON.stringify(f.reported));
});

test("a document handle posts messages and receives the messages of its own document", async () => {
  const f = fixture();
  const p = port();
  const region = attachRegion(p, f.element, "page", f.window, { report() {} });
  p.release();
  const received = [];
  region.onMessage((message) => received.push(message));
  await region.post({ type: "request", id: 1 });
  assert.deepEqual(p.calls.filter(([kind]) => kind === "post"), [["post", "page", { type: "request", id: 1 }]]);
  p.message("page", { type: "reply", id: 1 });
  p.message("other", { type: "ignored" });
  assert.deepEqual(received, [{ type: "reply", id: 1 }]);
  await region.detach();
  p.message("page", { type: "late" });
  assert.deepEqual(received, [{ type: "reply", id: 1 }]);
});

/** A port that also subscribes to the streams of the document. stream(document, handle, message) sends a stream message. */
function streamPort(replies = {}) {
  const p = port();
  let nextHandle = 1;
  let send = null;
  p.subscribe = async (name, stream) => {
    p.calls.push(["subscribe", name, stream]);
    const handle = replies.handle ?? nextHandle++;
    if (replies.beforeReply) replies.beforeReply(handle);
    return handle;
  };
  p.unsubscribe = async (name, handle) => { p.calls.push(["unsubscribe", name, handle]); };
  return p;
}

test("a stream subscription receives the messages of its handle and close ends it", async () => {
  const f = fixture();
  const p = streamPort();
  const region = attachRegion(p, f.element, "page", f.window, { report() {} });
  p.release();
  const received = [];
  const subscription = await region.subscribe("requests", (message) => received.push(message));
  p.stream("page", 1, { type: "entries", entries: [{ url: "a" }], dropped: 0 });
  p.stream("page", 2, { type: "entries", entries: [{ url: "other" }], dropped: 0 });
  p.stream("other", 1, { type: "entries", entries: [], dropped: 0 });
  assert.deepEqual(received, [{ type: "entries", entries: [{ url: "a" }], dropped: 0 }]);
  await subscription.close();
  assert.deepEqual(p.calls.filter(([kind]) => kind === "unsubscribe"), [["unsubscribe", "page", 1]]);
  p.stream("page", 1, { type: "entries", entries: [{ url: "late" }], dropped: 0 });
  assert.equal(received.length, 1);
});

test("a stream message that arrives before the subscribe reply reaches the listener", async () => {
  const f = fixture();
  const p = streamPort({ handle: 5, beforeReply: () => p.stream("page", 5, { type: "snapshot", seq: 1, nodes: [], total: 0, truncated: false }) });
  const region = attachRegion(p, f.element, "page", f.window, { report() {} });
  p.release();
  const received = [];
  await region.subscribe("elements", (message) => received.push(message));
  assert.deepEqual(received, [{ type: "snapshot", seq: 1, nodes: [], total: 0, truncated: false }]);
});

test("an unknown stream is rejected before the host is called", async () => {
  const f = fixture();
  const p = streamPort();
  const region = attachRegion(p, f.element, "page", f.window, { report() {} });
  p.release();
  await assert.rejects(region.subscribe("pixels", () => {}), /unknown document stream "pixels"/);
  assert.deepEqual(p.calls.filter(([kind]) => kind === "subscribe"), []);
});
