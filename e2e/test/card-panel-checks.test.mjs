import assert from "node:assert/strict";
import test from "node:test";

import { gripInk, missingPoses, requireCleared, requireContentWidth, tabSwitchPair } from "../card-panel-checks.mjs";

test("a pose without a recorded frame within two display frames is missing", () => {
  const frames = [{ time: 100, edges: [10] }, { time: 130, edges: [20] }, { time: 200, edges: [30] }];
  const poses = [{ displayed: 99, at: 10 }, { displayed: 120, at: 20 }, { displayed: 150, at: 30 }];
  assert.deepEqual(missingPoses(frames, poses, 60), [{ displayed: 150, at: 30 }]);
  assert.deepEqual(missingPoses(frames, poses.slice(0, 2), 60), []);
});

test("a pose displayed before the recording started counts from the first recorded frame", () => {
  const frames = [{ time: 200, edges: [10] }, { time: 216, edges: [20] }];
  // The recording started at 200 and the first state was displayed before that. If the first frame holds that state, it was recorded.
  assert.deepEqual(missingPoses(frames, [{ displayed: 100, at: 10 }, { displayed: 210, at: 20 }], 60), []);
  // A state that changed to the next state before the recording started cannot be recorded, so it cannot be counted as the first frame.
  assert.deepEqual(missingPoses(frames, [{ displayed: 100, at: 30 }, { displayed: 150, at: 10 }], 60), [{ displayed: 100, at: 30 }]);
});

test("a pose shown before its reported display time and after the previous pose counts as recorded", () => {
  // Measured example: the state is in frames 45, 29, and 12ms before the reported display time, and 21ms after it is the next state.
  const frames = [
    { time: -62, edges: [235] }, { time: -45, edges: [245] }, { time: -29, edges: [245] },
    { time: -12, edges: [245] }, { time: 21, edges: [255] },
  ];
  const poses = [{ displayed: -100, at: 235 }, { displayed: 0, at: 245 }, { displayed: 60, at: 255 }];
  assert.deepEqual(missingPoses(frames, poses, 60), []);
  // A frame before the earlier state was displayed is not a record of this state.
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

test("a top or bottom panel must span the card's content column", () => {
  assert.doesNotThrow(() => requireContentWidth({ width: 758 }, { w: 760 }, 1, 6, "top"));
  const sidebars = { left: { collapsed: false, shownSize: 190 }, right: { collapsed: true, shownSize: null } };
  assert.doesNotThrow(() => requireContentWidth({ width: 562 }, { w: 760, sidebars }, 1, 6, "bottom"));
  assert.throws(() => requireContentWidth({ width: 758 }, { w: 760, sidebars }, 1, 6, "bottom"),
    /bottom panel is 758 wide, not the card's content column width 562/);
});

test("grip ink measures the run that differs from the strip background along the middle line", () => {
  // A vertical grip of 6x100 (CSS) at scale 2. Only y 80..127 of the middle column (x=6) is bright.
  const image = { pixel: (x, y) => (x === 6 && y >= 80 && y < 128 ? [150, 150, 150] : [30, 30, 30]) };
  assert.deepEqual(gripInk(image, { x: 0, y: 0, width: 6, height: 100 }, 2), { longest: 48, total: 48, runs: 1, span: 48, length: 200 });
  // The full-length line of a horizontal grip is ink over its whole length.
  const line = { pixel: (x, y) => (y === 3 ? [150, 150, 150] : [30, 30, 30]) };
  assert.deepEqual(gripInk(line, { x: 10, y: 0, width: 50, height: 6 }, 1), { longest: 50, total: 50, runs: 1, span: 50, length: 50 });
  // The card border at the outer end of the band is not background. Only the short grip counts as ink.
  const bordered = { pixel: (x, y) => (x === 0 ? [60, 60, 60] : x === 3 && y >= 40 && y < 64 ? [150, 150, 150] : [30, 30, 30]) };
  assert.deepEqual(gripInk(bordered, { x: 0, y: 0, width: 6, height: 100 }, 1), { longest: 24, total: 24, runs: 1, span: 24, length: 100 });
  // Three points are three intervals, and the length from the first point to the last point is the span.
  const dots = { pixel: (x, y) => (x === 3 && [40, 41, 46, 47, 52, 53].includes(y) ? [150, 150, 150] : [30, 30, 30]) };
  assert.deepEqual(gripInk(dots, { x: 0, y: 0, width: 6, height: 100 }, 1), { longest: 2, total: 6, runs: 3, span: 14, length: 100 });
});

