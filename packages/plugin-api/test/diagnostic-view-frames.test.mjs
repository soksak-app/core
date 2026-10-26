import assert from "node:assert/strict";
import test from "node:test";
import { observeViewDocumentFrames } from "../diagnostic-view-frames.js";

function fixture() {
  const calls = [];
  const callbacks = new Map();
  const root = { rect: { width: 400, height: 300 }, getBoundingClientRect() { return this.rect; } };
  let observerCallback;
  let observed = null;
  let observeOptions = null;
  let disconnected = false;
  let nextFrame = 1;
  let nowMs = 10.25;
  const cancelled = [];
  class ResizeObserverProbe {
    constructor(callback) { observerCallback = callback; }
    observe(target, options) { observed = target; observeOptions = options; }
    disconnect() { disconnected = true; }
  }
  const requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id) => {
    cancelled.push(id);
    callbacks.delete(id);
  };
  const document = { documentElement: root };
  const log = { trace: (event, fields) => calls.push({ event, fields }) };
  return {
    calls, callbacks, root, document, log, ResizeObserverProbe, requestAnimationFrame, cancelAnimationFrame,
    cancelled, observer: () => observerCallback, observed: () => observed, observeOptions: () => observeOptions,
    disconnected: () => disconnected,
    now: () => nowMs, setNow: (value) => { nowMs = value; },
  };
}

function start(f) {
  return observeViewDocumentFrames({ document: f.document, log: f.log, ResizeObserver: f.ResizeObserverProbe,
    requestAnimationFrame: f.requestAnimationFrame, cancelAnimationFrame: f.cancelAnimationFrame, now: f.now,
    timeOriginMs: 1200 });
}

function activate(f) {
  const [frameId, callback] = [...f.callbacks.entries()][0];
  f.callbacks.delete(frameId);
  callback(8.5);
}

test("observation starts only on an animation frame and stop can cancel that start", { timeout: 5000 }, () => {
  const f = fixture();
  const stop = start(f);
  assert.equal(f.observed(), null, "ResizeObserver is not active before the first animation frame");
  assert.equal(f.callbacks.size, 1);
  const [frameId] = [...f.callbacks.entries()][0];
  stop();
  assert.deepEqual(f.cancelled, [frameId]);
  assert.equal(f.observed(), null, "stop before activation cannot install the observer");
});

test("the diagnostic observer logs document size only after the next animation frame", { timeout: 5000 }, () => {
  const f = fixture();
  const stop = start(f);
  activate(f);
  assert.equal(f.observed(), f.document.documentElement, "the view's document root is the observed content box");
  assert.deepEqual(f.observeOptions(), { box: "content-box" });
  f.observer()([{ target: f.document.documentElement }]);
  assert.equal(f.calls.length, 0, "ResizeObserver delivery alone is not the frame observation");
  const [frameId, callback] = [...f.callbacks.entries()][0];
  f.root.rect = { width: 420, height: 315 };
  f.callbacks.delete(frameId);
  callback(16.5);
  assert.deepEqual(f.calls, [{ event: "view.content_frame", fields: {
    sequence: 0, width: 420, height: 315, documentTimeOriginMs: 1200,
    firstResizeAtMs: 10.25, resizeAtMs: 10.25, resizeCount: 1, frameTimeMs: 16.5,
  } }]);
  assert.equal(f.callbacks.size, 0, "the next-frame callback is one-shot");
  stop();
});

test("a repeated resize before a pending animation frame is represented by that frame", { timeout: 5000 }, () => {
  const f = fixture();
  const stop = start(f);
  activate(f);
  f.setNow(10.25);
  f.observer()([{ target: f.document.documentElement }]);
  assert.equal(f.callbacks.size, 1, "the first root resize schedules one animation frame");

  f.root.rect = { width: 440, height: 330 };
  f.setNow(20.5);
  assert.doesNotThrow(() => f.observer()([{ target: f.document.documentElement }]),
    "another ResizeObserver delivery while the frame is pending must not escape as a page error");
  assert.equal(f.callbacks.size, 1, "coalesced resize delivery must not schedule a duplicate animation frame");

  const [frameId, callback] = [...f.callbacks.entries()][0];
  f.callbacks.delete(frameId);
  callback(26.5);
  assert.deepEqual(f.calls, [{ event: "view.content_frame", fields: {
    sequence: 0, width: 440, height: 330, documentTimeOriginMs: 1200,
    firstResizeAtMs: 10.25, resizeAtMs: 20.5, resizeCount: 2, frameTimeMs: 26.5,
  } }]);
  stop();
});

test("the next animation frame cannot precede its ResizeObserver source time", { timeout: 5000 }, () => {
  const f = fixture();
  const stop = start(f);
  activate(f);
  f.setNow(20.5);
  f.observer()([{ target: f.document.documentElement }]);
  const callback = [...f.callbacks.values()][0];
  assert.throws(() => callback(20.4), /animation timestamp precedes ResizeObserver time/);
  assert.equal(f.calls.length, 0, "an earlier animation timestamp cannot become evidence");
  stop();
});

test("stop disconnects the observer and cancels its pending frame without a late log", { timeout: 5000 }, () => {
  const f = fixture();
  const stop = start(f);
  activate(f);
  f.observer()([{ target: f.document.documentElement }]);
  const [frameId, callback] = [...f.callbacks.entries()][0];
  stop();
  callback(16.5);
  stop();
  assert.equal(f.disconnected(), true);
  assert.deepEqual(f.cancelled, [frameId]);
  assert.equal(f.calls.length, 0, "a callback delivered after stop cannot write an event");
});

test("the observer rejects a missing view document, logger, or animation-frame dependency", { timeout: 5000 }, () => {
  const f = fixture();
  const options = { document: f.document, log: f.log, ResizeObserver: f.ResizeObserverProbe,
    requestAnimationFrame: f.requestAnimationFrame, cancelAnimationFrame: f.cancelAnimationFrame, now: f.now, timeOriginMs: 1200 };
  assert.throws(() => observeViewDocumentFrames({ ...options, document: null }), /requires a view document/);
  assert.throws(() => observeViewDocumentFrames({ ...options, log: null }), /requires runtime\.log\.trace/);
  assert.throws(() => observeViewDocumentFrames({ ...options, requestAnimationFrame: null }), /requires requestAnimationFrame/);
  assert.throws(() => observeViewDocumentFrames({ ...options, now: null }), /requires performance\.now/);
});
