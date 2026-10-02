import assert from "node:assert/strict";
import test from "node:test";

import { gripInk, missingPoses, requireCleared, requireFullWidth, tabSwitchPair } from "../card-panel-checks.mjs";

test("a pose without a recorded frame within two display frames is missing", () => {
  const frames = [{ time: 100, edges: [10] }, { time: 130, edges: [20] }, { time: 200, edges: [30] }];
  const poses = [{ displayed: 99, at: 10 }, { displayed: 120, at: 20 }, { displayed: 150, at: 30 }];
  assert.deepEqual(missingPoses(frames, poses, 60), [{ displayed: 150, at: 30 }]);
  assert.deepEqual(missingPoses(frames, poses.slice(0, 2), 60), []);
});

test("a pose displayed before the recording started counts from the first recorded frame", () => {
  const frames = [{ time: 200, edges: [10] }, { time: 216, edges: [20] }];
  // 녹화는 200 에 시작했고 첫 상태는 그 전에 표시되었다. 첫 프레임이 그 상태를 담으면 녹화된 것이다.
  assert.deepEqual(missingPoses(frames, [{ displayed: 100, at: 10 }, { displayed: 210, at: 20 }], 60), []);
  // 녹화 시작 전에 다음 상태로 바뀐 상태는 녹화될 수 없으므로 첫 프레임으로 셀 수 없다.
  assert.deepEqual(missingPoses(frames, [{ displayed: 100, at: 30 }, { displayed: 150, at: 10 }], 60), [{ displayed: 100, at: 30 }]);
});

test("a pose shown before its reported display time and after the previous pose counts as recorded", () => {
  // 측정 예: 상태는 보고된 표시 시각보다 45, 29, 12ms 앞선 프레임에 있고, 21ms 뒤에는 다음 상태다.
  const frames = [
    { time: -62, edges: [235] }, { time: -45, edges: [245] }, { time: -29, edges: [245] },
    { time: -12, edges: [245] }, { time: 21, edges: [255] },
  ];
  const poses = [{ displayed: -100, at: 235 }, { displayed: 0, at: 245 }, { displayed: 60, at: 255 }];
  assert.deepEqual(missingPoses(frames, poses, 60), []);
  // 이전 상태가 표시되기 전의 프레임은 이 상태의 기록이 아니다.
  const stale = [{ time: -150, edges: [245] }, { time: -95, edges: [235] }, { time: 21, edges: [255] }];
  assert.deepEqual(missingPoses(stale, poses, 60), [{ displayed: 0, at: 245 }]);
});

test("panels left after clearing are rejected, including default ones", () => {
  assert.doesNotThrow(() => requireCleared({}));
  assert.throws(() => requireCleared({ top: { set: "space-list", collapsed: false } }), /panels remained after clearing: top/);
});

test("a tab switch fixture requires a tab of a different plugin", () => {
  const cards = [{ id: "a", active: "t1", tabs: [{ id: "t1", plugin: "terminal" }] },
    { id: "b", active: "t2", tabs: [{ id: "t2", plugin: "browser" }] }];
  assert.deepEqual(tabSwitchPair(cards[0], cards), { original: cards[0].tabs[0], other: cards[1].tabs[0], from: "b" });
  assert.throws(() => tabSwitchPair(cards[0], [cards[0]]), /no tab of a plugin other than terminal/);
});

test("a top or bottom panel must span the card's inner width", () => {
  assert.doesNotThrow(() => requireFullWidth({ width: 758 }, { w: 760 }, 1, "top"));
  assert.throws(() => requireFullWidth({ width: 568 }, { w: 760 }, 1, "top"), /top panel is 568 wide, not the card's inner width 758/);
});

test("grip ink measures the run that differs from the strip background along the middle line", () => {
  // 세로 grip 6x100(CSS), 배율 2. 가운데 열(x=6)의 y 80..127 만 밝다.
  const image = { pixel: (x, y) => (x === 6 && y >= 80 && y < 128 ? [150, 150, 150] : [30, 30, 30]) };
  assert.deepEqual(gripInk(image, { x: 0, y: 0, width: 6, height: 100 }, 2), { longest: 48, total: 48, length: 200 });
  // 가로 grip 의 전체 길이 선은 길이 전체가 잉크다.
  const line = { pixel: (x, y) => (y === 3 ? [150, 150, 150] : [30, 30, 30]) };
  assert.deepEqual(gripInk(line, { x: 10, y: 0, width: 50, height: 6 }, 1), { longest: 50, total: 50, length: 50 });
  // 띠 바깥 끝의 카드 테두리는 배경이 아니다. 짧은 grip 만 잉크로 센다.
  const bordered = { pixel: (x, y) => (x === 0 ? [60, 60, 60] : x === 3 && y >= 40 && y < 64 ? [150, 150, 150] : [30, 30, 30]) };
  assert.deepEqual(gripInk(bordered, { x: 0, y: 0, width: 6, height: 100 }, 1), { longest: 24, total: 24, length: 100 });
});

