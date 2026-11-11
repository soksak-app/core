import assert from "node:assert/strict";
import test from "node:test";

import { gripInk, missingPoses, panelSurfaceRect, requireCleared, requireContentWidth, tabSwitchPair } from "../card-panel-checks.mjs";

const sixty = Array.from({ length: 2001 }, (_, index) => -1000 + index * 1000 / 60);
const onetwenty = Array.from({ length: 2001 }, (_, index) => -1000 + index * 1000 / 120);

test("a pose absent from the first recorded frame after two display frames is missing", () => {
  const frames = [{ time: 100, edges: [10] }, { time: 130, edges: [20] }, { time: 200, edges: [40] }, { time: 210, edges: [30] }];
  const poses = [{ displayed: 99, at: 10 }, { displayed: 120, at: 20 }, { displayed: 150, at: 30 }];
  assert.deepEqual(missingPoses(frames, poses, sixty), [{ displayed: 150, at: 30 }]);
  assert.deepEqual(missingPoses(frames, poses.slice(0, 2), sixty), []);
});

test("a pose in the first frame that a recording gap delivers after two display frames counts as recorded", () => {
  // Measured example at 120 Hz: the stream delivered no frame between 32.2 ms before and 20.3 ms after the display time.
  const frames = [{ time: -32.2, edges: [147] }, { time: 20.3, edges: [137] }, { time: 34, edges: [137] }];
  assert.deepEqual(missingPoses(frames, [{ displayed: -60, at: 147 }, { displayed: 0, at: 137 }], onetwenty), []);
});

test("a pose with no recorded frame after two display frames is missing", () => {
  const frames = [{ time: -32.2, edges: [147] }, { time: 5, edges: [147] }];
  assert.deepEqual(missingPoses(frames, [{ displayed: -60, at: 147 }, { displayed: 0, at: 137 }], onetwenty), [{ displayed: 0, at: 137 }]);
});

test("a pose displayed before the recording started counts from the first recorded frame", () => {
  const frames = [{ time: 200, edges: [10] }, { time: 216, edges: [20] }];
  // The recording started at 200 and the first state was displayed before that. If the first frame holds that state, it was recorded.
  assert.deepEqual(missingPoses(frames, [{ displayed: 100, at: 10 }, { displayed: 210, at: 20 }], sixty), []);
  // A state that changed to the next state before the recording started cannot be recorded, so it cannot be counted as the first frame.
  assert.deepEqual(missingPoses(frames, [{ displayed: 100, at: 30 }, { displayed: 150, at: 10 }], sixty), [{ displayed: 100, at: 30 }]);
});

test("a pose counts as recorded when its frame falls inside the observed refresh window", () => {
  // The display refreshes every 1000/60 ms. The state is displayed at 100 ms, so its window ends at the second refresh after it (about 166.7 ms).
  // A window computed from 120 Hz would end at about 116.7 ms and would miss the frame at 150 ms.
  const frames = [{ time: 100, edges: [10] }, { time: 150, edges: [20] }, { time: 200, edges: [30] }];
  assert.deepEqual(missingPoses(frames, [{ displayed: 100, at: 10 }, { displayed: 110, at: 20 }], sixty), []);
});

test("a pose shown before its reported display time and after the previous pose counts as recorded", () => {
  // Measured example: the state is in frames 45, 29, and 12ms before the reported display time, and 21ms after it is the next state.
  const frames = [
    { time: -62, edges: [235] }, { time: -45, edges: [245] }, { time: -29, edges: [245] },
    { time: -12, edges: [245] }, { time: 21, edges: [255] },
  ];
  const poses = [{ displayed: -100, at: 235 }, { displayed: 0, at: 245 }, { displayed: 60, at: 255 }];
  assert.deepEqual(missingPoses(frames, poses, sixty), []);
  // A frame before the earlier state was displayed is not a record of this state.
  const stale = [{ time: -150, edges: [245] }, { time: -95, edges: [235] }, { time: 21, edges: [255] }];
  assert.deepEqual(missingPoses(stale, poses, sixty), [{ displayed: 0, at: 245 }]);
});

test("panels left after clearing are rejected, including default ones", () => {
  assert.doesNotThrow(() => requireCleared({}));
  assert.throws(() => requireCleared({ top: { set: "space-list", collapsed: false } }), /panels remained after clearing: top/);
});

test("a tab switch fixture requires a tab of a different plugin", () => {
  const cards = [{ id: "a", active: "t1", tabs: [{ id: "t1", plugin: "layoutprobe" }] },
    { id: "b", active: "t2", tabs: [{ id: "t2", plugin: "probeplain" }] }];
  assert.deepEqual(tabSwitchPair(cards[0], cards), { original: cards[0].tabs[0], other: cards[1].tabs[0], from: "b" });
  assert.throws(() => tabSwitchPair(cards[0], [cards[0]]), /no tab of a plugin other than layoutprobe/);
});

test("a top or bottom panel must span the card's content column", () => {
  assert.doesNotThrow(() => requireContentWidth({ width: 758 }, { w: 760 }, 1, 6, "top"));
  const sidebars = { left: { collapsed: false, shownSize: 190 }, right: { collapsed: true, shownSize: null } };
  assert.doesNotThrow(() => requireContentWidth({ width: 562 }, { w: 760, sidebars }, 1, 6, "bottom"));
  assert.throws(() => requireContentWidth({ width: 758 }, { w: 760, sidebars }, 1, 6, "bottom"),
    /bottom panel is 758 wide, not the card's content column width 562/);
});

test("the native surface leaves the shown size of each open side and the divider of each folded side", () => {
  // Measured on the start card of the layoutprobe fixture: the card is 315.6 points high, so the top side stored at 190 is shown at
  // 163.5, which leaves the 96-point layout minimum to the content (315.6 - 2 - 32 - 22 - 96 = 163.6, on the 2x device pixel grid).
  // The hosts applied y 634 and h 96, the device pixel grid of 83 + 354.4 + 1 + 32 + 163.5 = 633.9 and 315.6 - 56 - 163.5 = 96.1.
  const open = { collapsed: false, size: 190, shownSize: 190 };
  const card = { x: 202, y: 354.4, w: 762, h: 315.6, sidebars: { left: open, right: open, top: { collapsed: false, size: 190, shownSize: 163.5 } } };
  const metrics = { border: 1, head: 32, foot: 22, divider: 6 };
  const rect = panelSurfaceRect({ x: 7, y: 83 }, card, metrics);
  assert.deepEqual(Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * 10) / 10])),
    { x: 400, y: 633.9, w: 380, h: 96.1 });
  const folded = { ...card, sidebars: { left: open, bottom: { collapsed: true, size: 190, shownSize: null } } };
  assert.deepEqual(panelSurfaceRect({ x: 0, y: 0 }, folded, metrics), { x: 393, y: 387.4, w: 570, h: 315.6 - 2 - 32 - 22 - 6 });
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

test("grip ink takes the background of the band, not the boundary line that the band holds at its edge", () => {
  // Measured on mygo: the folded bottom side of a card has its grip at y 396.4, 6 points high, at 2x. Its boundary line with the content
  // is the top 1 point of the band, device rows 792.8 to 794.8, drawn on rows 793 and 794. The three 3-point dots lie at the center of
  // the band, rows 796 to 801, 6 points apart around x 590 (device 1180).
  const dot = (x) => [1165, 1177, 1189].some((left) => x >= left && x < left + 6);
  const image = { pixel: (x, y) => (y === 793 || y === 794 ? [70, 70, 70] : y >= 796 && y < 802 && dot(x) ? [150, 150, 150] : [30, 30, 30]) };
  assert.deepEqual(gripInk(image, { x: 216, y: 396.4, width: 748, height: 6 }, 2), { longest: 6, total: 18, runs: 3, span: 30, length: 1496 });
});
