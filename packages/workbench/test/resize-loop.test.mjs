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
    "resize observer loop: before the round, undelivered at the first callback: nothing",
    "resize observer loop: in the round callback 1 ran page@wails://localhost/page.js:1:1 created at 1234.6ms at 1234.6ms on div#plane.plane.stage[data-expose=core.plane] 1186x670, then changed nothing",
    "resize observer loop: after the round changed nothing",
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
  assert.deepEqual(reported, [
    "resize observer loop: before the round, undelivered at the first callback: nothing",
    "resize observer loop: in the round callback 1 ran probe@wails://localhost/probe.js:7:3 created at 1234.6ms at 1234.6ms on div#plane.plane.stage[data-expose=core.plane] 600x400, then changed nothing",
  ]);
  frame();
  frame();
  assert.equal(reported.length, 4);
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
  assert.deepEqual(reported, [
    "resize observer loop: before the round, undelivered at the first callback: nothing",
    "resize observer loop: this frame ran no callback",
  ]);
});

test("each DOM change is reported in the callback slot of the round it happened in, or after the round", async () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  let made = 0;
  watchResizeLoop(window, (line) => reported.push(line), () => `probe@wails://localhost/probe.js:${++made}:1`);
  const plane = window.document.getElementById("plane");
  // callback 1 의 변경 기록은 그 callback 뒤 microtask checkpoint 에서 MutationObserver 로 전달된다.
  new window.ResizeObserver(() => plane.setAttribute("data-height", "517"));
  // callback 2 의 변경 기록은 checkpoint 없이 callback 3 이 오므로 전달되지 않은 기록으로 남는다.
  new window.ResizeObserver(() => plane.setAttribute("title", "tree"));
  new window.ResizeObserver(() => {});
  const entry = { target: plane, contentRect: { width: 188, height: 498 } };

  observers[0].callback([entry], observers[0]);
  await new Promise((resolve) => queueMicrotask(resolve));
  observers[1].callback([entry], observers[1]);
  observers[2].callback([entry], observers[2]);
  window.dispatchEvent(new window.ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
  // 관찰 round 가 끝난 뒤의 task 가 바꾼 것은 round 안의 변경이 아니다.
  await new Promise((resolve) => setTimeout(resolve, 0));
  plane.hidden = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
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
