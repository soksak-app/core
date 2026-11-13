// Checks that the observation delivered in the next frame after a ResizeObserver loop error is recorded (G1.4-115).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { watchResizeLoop } from "../resize-loop.js";

function fakeView() {
  const { window } = new JSDOM(`<div id="plane" class="plane stage" data-expose="core.plane"></div>`);
  const observers = [];
  const frames = [];
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
  };
  window.requestAnimationFrame = (fn) => frames.push(fn);
  // The next task after a rendering update: the fixture delivers the posted messages when the test runs task().
  const messages = [];
  window.MessageChannel = class {
    constructor() {
      const port1 = { onmessage: null, close() {} };
      this.port1 = port1;
      this.port2 = { postMessage: () => messages.push(port1) };
    }
  };
  const frame = () => frames.splice(0).forEach((fn) => fn());
  const task = () => messages.splice(0).forEach((port) => port.onmessage?.({}));
  return { window, observers, frame, frames, task };
}

// The reading of the clock in each record is passed in, so every record of a test reads the same instant.
const at = () => 1234.56;

/** Starts the recorder of window with the reading `at`; locate and trace take their defaults when they are omitted. */
const watch = (window, reported, locate, trace) => watchResizeLoop(window, (line) => reported.push(line), locate, trace, at);

/** Resolves when the mutation records of target that happen after this call are delivered to a MutationObserver of the test. */
function delivered(window, target) {
  return new Promise((resolve) => {
    const observer = new window.MutationObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

test("the observations delivered in the frame after a loop error are reported", () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  watch(window, reported, () => "page@wails://localhost/page.js:1:1");
  const delivered = [];
  new window.ResizeObserver((entries) => delivered.push(entries.length));
  const plane = window.document.getElementById("plane");
  const entry = { target: plane, contentRect: { width: 1186.4, height: 670 } };

  observers[0].callback([entry], observers[0]);
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  frame();
  observers[0].callback([entry], observers[0]);
  frame();

  assert.deepEqual(delivered, [1, 1], "the page callback did not run");
  assert.deepEqual(reported, [
    "resize observer loop: before the round, undelivered at the first callback: nothing",
    "resize observer loop: in the round callback 1 ran page@wails://localhost/page.js:1:1 created at 1234.6ms at 1234.6ms on div#plane.plane.stage[data-expose=core.plane] 1186x670, then changed nothing",
    "resize observer loop: after the round changed nothing",
    "resize observer loop: the next frame delivered div#plane.plane.stage[data-expose=core.plane] 1186x670",
  ]);
});

test("another error does not start a record", () => {
  const { window, frame } = fakeView();
  const reported = [];
  watch(window, reported);
  window.dispatchEvent(new window.ErrorEvent("error", { message: "something else" }));
  frame();
  frame();
  assert.deepEqual(reported, []);
});

test("the callbacks that ran in the frame of a loop error are reported with the code that created each observer", () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  watch(window, reported, () => "probe@wails://localhost/probe.js:7:3");
  new window.ResizeObserver(() => {});
  const plane = window.document.getElementById("plane");
  observers[0].callback([{ target: plane, contentRect: { width: 600, height: 400 } }], observers[0]);
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  assert.deepEqual(reported, [
    "resize observer loop: before the round, undelivered at the first callback: nothing",
    "resize observer loop: in the round callback 1 ran probe@wails://localhost/probe.js:7:3 created at 1234.6ms at 1234.6ms on div#plane.plane.stage[data-expose=core.plane] 600x400, then changed nothing",
  ]);
  frame();
  frame();
  assert.equal(reported.length, 4);
});

test("the callbacks of an earlier frame are not reported with a loop error", () => {
  const { window, observers, task } = fakeView();
  const reported = [];
  watch(window, reported, () => "probe@wails://localhost/probe.js:7:3");
  new window.ResizeObserver(() => {});
  const plane = window.document.getElementById("plane");
  observers[0].callback([{ target: plane, contentRect: { width: 600, height: 400 } }], observers[0]);
  task();
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  assert.deepEqual(reported, [
    "resize observer loop: before the round, undelivered at the first callback: nothing",
    "resize observer loop: this frame ran no callback",
  ]);
});

test("each DOM change is reported in the callback slot of the round it happened in, or after the round", async () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  let made = 0;
  watch(window, reported, () => `probe@wails://localhost/probe.js:${++made}:1`);
  const plane = window.document.getElementById("plane");
  // The change records of callback 1 are delivered to the MutationObserver at the microtask checkpoint after that callback.
  new window.ResizeObserver(() => plane.setAttribute("data-height", "517"));
  // The change records of callback 2 remain undelivered, because callback 3 comes without a checkpoint.
  new window.ResizeObserver(() => plane.setAttribute("title", "tree"));
  new window.ResizeObserver(() => {});
  const entry = { target: plane, contentRect: { width: 188, height: 498 } };

  const recorded = delivered(window, plane);
  observers[0].callback([entry], observers[0]);
  await recorded;
  observers[1].callback([entry], observers[1]);
  observers[2].callback([entry], observers[2]);
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  // A change after the loop error is not a change inside the round.
  const hidden = delivered(window, plane);
  plane.hidden = true;
  await hidden;
  frame();
  frame();

  const target = "div#plane.plane.stage[data-expose=core.plane]";
  assert.deepEqual(reported, [
    "resize observer loop: before the round, undelivered at the first callback: nothing",
    `resize observer loop: in the round callback 1 ran probe@wails://localhost/probe.js:1:1 created at 1234.6ms at 1234.6ms on ${target} 188x498, then changed attributes data-height of ${target}`,
    `resize observer loop: in the round callback 2 ran probe@wails://localhost/probe.js:2:1 created at 1234.6ms at 1234.6ms on ${target} 188x498, then changed attributes title of ${target}`,
    `resize observer loop: in the round callback 3 ran probe@wails://localhost/probe.js:3:1 created at 1234.6ms at 1234.6ms on ${target} 188x498, then changed nothing`,
    `resize observer loop: after the round changed attributes hidden of ${target}`,
    "resize observer loop: the next frame delivered no observation",
  ]);
});

// A MutationObserver record does not hold the code that made the change. The test appends the stack of the code that wrote the dataset of body inside a callback slot of the observation round
// after the line of that slot, so a measurement finds the code that started the screen switch (F43).
test("a body dataset write inside a callback slot is reported with the stack of the code that wrote it", async () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  watch(window, reported, () => "probe@wails://localhost/probe.js:1:1",
    () => "drawBars@wails://localhost/index.html:419:30 < @wails://localhost/projects.js:64:5");
  const body = window.document.body;
  // A write outside the round is not recorded.
  body.dataset.screen = "workspace";
  const plane = window.document.getElementById("plane");
  new window.ResizeObserver(() => queueMicrotask(() => { body.dataset.screen = "library"; delete body.dataset.dragging; }));
  // The writes run in a microtask of the callback; the delivery of their records to the test observer follows them.
  const written = delivered(window, body);
  observers[0].callback([{ target: plane, contentRect: { width: 188, height: 498 } }], observers[0]);
  await written;
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  frame();
  frame();

  assert.equal(body.getAttribute("data-screen"), "library", "the traced dataset did not write the attribute");
  assert.deepEqual(reported.slice(1, 4), [
    "resize observer loop: in the round callback 1 ran probe@wails://localhost/probe.js:1:1 created at 1234.6ms at 1234.6ms on div#plane.plane.stage[data-expose=core.plane] 188x498, then changed attributes data-screen of body",
    "resize observer loop: in the round callback 1 set data-screen of body to library at drawBars@wails://localhost/index.html:419:30 < @wails://localhost/projects.js:64:5",
    "resize observer loop: in the round callback 1 removed data-dragging of body at drawBars@wails://localhost/index.html:419:30 < @wails://localhost/projects.js:64:5",
  ]);
});

test("a callback round requests no animation frame and the next task ends its slots", () => {
  const { window, observers, frames, task } = fakeView();
  const reported = [];
  watch(window, reported, () => "probe@wails://localhost/probe.js:7:3");
  new window.ResizeObserver(() => {});
  const plane = window.document.getElementById("plane");
  observers[0].callback([{ target: plane, contentRect: { width: 600, height: 400 } }], observers[0]);
  // An animation frame starts a rendering update, and its layer commit can hold the presentation of the next layout draw.
  assert.equal(frames.length, 0, "a callback round of the recorder requested an animation frame");
  task();
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  assert.deepEqual(reported, [
    "resize observer loop: before the round, undelivered at the first callback: nothing",
    "resize observer loop: this frame ran no callback",
  ]);
});
