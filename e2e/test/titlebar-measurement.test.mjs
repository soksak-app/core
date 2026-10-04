// 합성한 프레임으로 창 단추와 첫 행의 측정과 판정을 검사한다. 실제 창의 단추 위치를 대신하지 않는다.
import assert from "node:assert/strict";
import test from "node:test";

import { measureTitlebar, misaligned, rowHeight } from "../titlebar-measurement.mjs";

const CARD = [25, 27, 36];
const EDGE = [43, 46, 61];
const BACKGROUND = [16, 17, 23];
// 비활성 창의 단추 색.
const BUTTON = [72, 72, 78];
// 창 좌표(pt)의 단추 세 개. 세로 위치는 측정에 쓰지 않는다.
const BUTTONS = [9, 29, 49].map((x) => ({ x, y: 0, width: 14, height: 14 }));

/**
 * 창 위에서 row pt 높이의 첫 행(아래 1pt 는 테두리)과 세로 가운데가 centre pt 인 지름 14pt 단추들을 그린 프레임.
 * 창은 버퍼의 offset(버퍼 pt)에 있고, 창 밖과 왼쪽 위 모서리는 검은색이다.
 */
function synthetic({ row, centre, buttons = BUTTONS, scale = 2, offset = { x: 3, y: 2 }, time = 0 }) {
  const size = { width: 200, height: 240 };
  const width = (offset.x + size.width) * scale;
  const height = (offset.y + size.height) * scale;
  const data = Buffer.alloc(width * height * 4);
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      // 화소 가운데의 창 좌표(pt).
      const x = (dx + 0.5) / scale - offset.x;
      const y = (dy + 0.5) / scale - offset.y;
      let colour = [0, 0, 0];
      if (x >= 0 && y >= 0 && x < size.width && y < size.height && !(x < 6 && y < 6)) {
        colour = y < row - 1 ? CARD : y < row ? EDGE : y < row + 5 ? CARD : BACKGROUND;
        if (centre !== null && buttons.some((button) => Math.hypot(x - (button.x + 7), y - centre) <= 7)) colour = BUTTON;
      }
      data.set([colour[2], colour[1], colour[0], 255], (dy * width + dx) * 4);
    }
  }
  return { width, height, stride: width * 4, content: { x: offset.x, y: offset.y, ...size }, contentScale: 1, scale, time, data };
}

test("the first-row height follows the page row at every frame factor step", () => {
  assert.deepEqual([0.5, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(rowHeight), [40, 40, 40, 45, 54, 63, 72, 90, 108]);
});

test("buttons centred in the first row measure no difference at every row height", () => {
  for (const row of [40, 45, 54, 63, 72, 90, 108]) {
    const measured = measureTitlebar(synthetic({ row, centre: row / 2 }), BUTTONS);
    assert.equal(measured.missing, undefined, `row ${row}: ${measured.missing}`);
    assert.equal(measured.row, row, `row ${row}: the first-row edge`);
    assert.equal(measured.buttons, row / 2, `row ${row}: the button centre`);
    assert.deepEqual(misaligned([measured]), [], `row ${row}`);
  }
});

test("buttons 6px off the first-row centre fail the frame", () => {
  // 행은 54px 로 그려졌는데 단추는 이전 제목줄 66pt 의 가운데에 있다.
  const measured = [measureTitlebar(synthetic({ row: 54, centre: 27, time: 1 }), BUTTONS),
    measureTitlebar(synthetic({ row: 54, centre: 33, time: 2 }), BUTTONS)];
  assert.equal(measured[1].difference, 6);
  assert.deepEqual(misaligned(measured).map((frame) => frame.time), [2]);
});

test("a difference of 0.5px passes and 1px fails", () => {
  assert.deepEqual(misaligned([measureTitlebar(synthetic({ row: 54, centre: 27.5 }), BUTTONS)]), []);
  const off = measureTitlebar(synthetic({ row: 54, centre: 28 }), BUTTONS);
  assert.equal(off.difference, 1);
  assert.equal(misaligned([off]).length, 1);
});

test("buttons moved sideways from the reported frames keep their measured centre", () => {
  const moved = BUTTONS.map((button) => ({ ...button, x: button.x + 3 }));
  const measured = measureTitlebar(synthetic({ row: 72, centre: 36, buttons: moved }), BUTTONS);
  assert.equal(measured.buttons, 36);
});

test("a frame without buttons, without the first-row edge, or with buttons at the scan start is not passed", () => {
  const cases = [
    [synthetic({ row: 54, centre: null }), /no window button/],
    [synthetic({ row: 239, centre: 20 }), /no first-row edge/],
    [synthetic({ row: 54, centre: 12 }), /reaches the scan start/],
  ];
  for (const [frame, reason] of cases) {
    const [measured] = misaligned([measureTitlebar(frame, BUTTONS)]);
    assert.match(measured?.missing ?? "", reason);
  }
  assert.throws(() => measureTitlebar(synthetic({ row: 54, centre: 27 }), []), /no button frames/);
});
