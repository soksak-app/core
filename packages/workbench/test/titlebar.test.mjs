import assert from "node:assert/strict";
import test from "node:test";
import { TEXT_STEPS } from "../text-size.js";
import { fitTitlebar } from "../titlebar.js";

// 창의 제목줄을 흉내 낸다. AppKit 처럼 정한 높이의 세로 가운데에 14pt 단추를 두고, 전체 화면에서는 제목줄이 없다.
function fakeWindow(height = 40) {
  const window = { height, fullscreen: false, requests: [] };
  window.chrome = {
    controls: async () => {
      const row = window.fullscreen ? 0 : window.height;
      return { controls: { x: 13, y: (row - 14) / 2, w: 54, h: 14 }, row };
    },
    titlebar: async (value) => {
      window.requests.push(value);
      if (window.fullscreen) throw new Error("the window shows no title bar in full screen");
      window.height = value;
    },
  };
  return window;
}

// app.css 의 첫 행: round(max(--chrome-h, --chrome-row-h × 프레임 배율)). --chrome-h 는 40px 로 고정이고 창의 답에서 오지 않는다.
const row = (factor) => Math.round(Math.max(40, 36 * factor));

test("the page sets the title bar to its first row at every frame factor and the buttons stay centred", async () => {
  const window = fakeWindow();
  // 배율을 끝까지 올렸다가 끝까지 내린다. 행이 창의 답에 따라 커지면 내릴 때 줄어들지 않는다.
  for (const factor of [...TEXT_STEPS, ...[...TEXT_STEPS].reverse(), 1]) {
    const wanted = row(factor);
    const answer = await fitTitlebar(window.chrome, () => wanted);
    assert.equal(answer.row, wanted, `factor ${factor}: the title bar follows the ${wanted}px row`);
    const above = answer.controls.y;
    const below = wanted - (answer.controls.y + answer.controls.h);
    assert.ok(Math.abs(above - below) <= 0.5, `factor ${factor}: above ${above}, below ${below}`);
  }
  assert.equal(window.height, 40, "the title bar returns to 40pt at factor 1");
});

test("a second fit with the same row requests nothing, so the row converges after one request", async () => {
  const window = fakeWindow();
  await fitTitlebar(window.chrome, () => row(1.5));
  assert.deepEqual(window.requests, [54]);
  await fitTitlebar(window.chrome, () => row(1.5));
  await fitTitlebar(window.chrome, () => row(1.5));
  assert.deepEqual(window.requests, [54], "the answer does not change the row, so no further request follows");
  await fitTitlebar(window.chrome, () => row(1));
  assert.deepEqual(window.requests, [54, 40]);
});

test("in full screen the page requests no title bar height and sets it after the window leaves full screen", async () => {
  const window = fakeWindow();
  window.fullscreen = true;
  const answer = await fitTitlebar(window.chrome, () => row(2));
  assert.equal(answer.row, 0);
  assert.deepEqual(window.requests, [], "a window without a title bar gets no height");
  window.fullscreen = false;
  assert.equal((await fitTitlebar(window.chrome, () => row(2))).row, 72);
  assert.deepEqual(window.requests, [72]);
});

test("a title bar that does not take the requested height is an error that names both heights", async () => {
  const window = fakeWindow();
  window.chrome.titlebar = async (value) => window.requests.push(value);
  await assert.rejects(fitTitlebar(window.chrome, () => 54), /window title bar is 40pt after the page requested 54pt/);
});

test("a refused request reaches the caller", async () => {
  const window = fakeWindow();
  window.chrome.titlebar = async () => { throw new Error("title bar height must be a finite number from 32 through 200 points"); };
  await assert.rejects(fitTitlebar(window.chrome, () => 54), /from 32 through 200 points/);
});
