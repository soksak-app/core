// ResizeObserver 루프 오류 뒤 다음 frame 에 전달된 관찰을 기록하는지 검사한다(G1.4-115).
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
  window.performance.now = () => 1234.56;
  const frame = () => frames.splice(0).forEach((fn) => fn());
  return { window, observers, frame };
}

test("the observations delivered in the frame after a loop error are reported", () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  watchResizeLoop(window, (line) => reported.push(line), () => "page@wails://localhost/page.js:1:1");
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
    "resize observer loop: this frame ran page@wails://localhost/page.js:1:1 at 1234.6ms on div#plane.plane.stage[data-expose=core.plane] 1186x670",
    "resize observer loop: the next frame delivered div#plane.plane.stage[data-expose=core.plane] 1186x670",
  ]);
});

test("another error does not start a record", () => {
  const { window, frame } = fakeView();
  const reported = [];
  watchResizeLoop(window, (line) => reported.push(line));
  window.dispatchEvent(new window.ErrorEvent("error", { message: "something else" }));
  frame();
  frame();
  assert.deepEqual(reported, []);
});

test("the callbacks that ran in the frame of a loop error are reported with the code that created each observer", () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  watchResizeLoop(window, (line) => reported.push(line), () => "probe@wails://localhost/probe.js:7:3");
  new window.ResizeObserver(() => {});
  const plane = window.document.getElementById("plane");
  observers[0].callback([{ target: plane, contentRect: { width: 600, height: 400 } }], observers[0]);
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  assert.deepEqual(reported,
    ["resize observer loop: this frame ran probe@wails://localhost/probe.js:7:3 at 1234.6ms on div#plane.plane.stage[data-expose=core.plane] 600x400"]);
  frame();
  frame();
  assert.equal(reported.length, 2);
});

test("the callbacks of an earlier frame are not reported with a loop error", () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  watchResizeLoop(window, (line) => reported.push(line), () => "probe@wails://localhost/probe.js:7:3");
  new window.ResizeObserver(() => {});
  const plane = window.document.getElementById("plane");
  observers[0].callback([{ target: plane, contentRect: { width: 600, height: 400 } }], observers[0]);
  frame();
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  assert.deepEqual(reported, ["resize observer loop: this frame ran no callback"]);
});
