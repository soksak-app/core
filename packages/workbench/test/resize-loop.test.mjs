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
  const frame = () => frames.splice(0).forEach((fn) => fn());
  return { window, observers, frame };
}

test("the observations delivered in the frame after a loop error are reported", () => {
  const { window, observers, frame } = fakeView();
  const reported = [];
  watchResizeLoop(window, (line) => reported.push(line));
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
  assert.deepEqual(reported,
    ["resize observer loop: the next frame delivered div#plane.plane.stage[data-expose=core.plane] 1186x670"]);
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
