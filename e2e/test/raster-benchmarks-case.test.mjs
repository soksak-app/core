// The plans of the click, scroll and layout redraw benchmarks (e2e/benchmark/cases/raster-cards.mjs, click-cpu.mjs, scroll-cpu.mjs,
// layout-redraw.mjs): the grid of raster probe cards, the order of the clicks, the wheels and the frames of each action.
import assert from "node:assert/strict";
import test from "node:test";

import { clickOrder, displayFrames, focusTimes } from "../benchmark/cases/click-cpu.mjs";
import { actionFrames, blankFigures, dragStages, redrawActions, regionRaster, stageLine } from "../benchmark/cases/layout-redraw.mjs";
import { boundaryMoves, startRows, widestCard } from "../benchmark/cases/raster-cards.mjs";
import { steppedOffset, wheelDelta } from "../benchmark/cases/scroll-cpu.mjs";

const card = (id, x, y, w, h, pane = id) => ({ id, x, y, w, h, pane });

test("the rows of the grid are the first content cards of one column of the start layout", { timeout: 5000 }, () => {
  const grid = { cards: [card("left", 0, 0, 190, 700, null), card("browser", 190, 360, 800, 340), card("terminal", 190, 0, 800, 360)] };
  assert.deepEqual(startRows(grid, 2), ["terminal", "browser"]);
  assert.deepEqual(startRows(grid, 1), ["terminal"]);
  assert.throws(() => startRows(grid, 3), /not 3 or more cards in one column/);
  assert.throws(() => startRows({ cards: [card("a", 0, 0, 400, 700), card("b", 400, 0, 400, 700)] }, 1), /in one column/);
});

test("a row splits at its widest card, and the cleanup moves back each line that stands elsewhere", { timeout: 5000 }, () => {
  const grid = { cards: [card("a", 0, 0, 200, 10), card("b", 200, 0, 400, 10), card("c", 600, 0, 400, 10)] };
  assert.equal(widestCard(grid, ["a", "b", "c"]), "b");
  assert.deepEqual(boundaryMoves({ x: [0, 400, 800], y: [0, 300] }, { x: [0, 420, 800], y: [0, 300.4] }), [{ axis: "x", line: 1, position: 400 }]);
  assert.throws(() => boundaryMoves({ x: [0, 800], y: [0] }, { x: [0, 400, 800], y: [0] }), /3 x lines, not the 2 of the start/);
});

test("the clicks visit each card in turn from the card after the focused one", { timeout: 5000 }, () => {
  const cards = ["a", "b", "c"].map((id) => ({ card: id }));
  assert.deepEqual(clickOrder(cards, "b", 5).map(({ card: id }) => id), ["c", "a", "b", "c", "a"]);
  assert.deepEqual(clickOrder(cards, undefined, 2).map(({ card: id }) => id), ["a", "b"]);
  assert.deepEqual(focusTimes([30, 10, 20, 40]), { count: 4, medianMs: 20, p90Ms: 40, maxMs: 40, sumMs: 100 });
});

test("a wheel toward older lines has a negative distance of whole points, and a wheel that does not move that way fails", { timeout: 5000 }, () => {
  assert.equal(wheelDelta({ grid: { cellHeight: 32 }, scale: 2 }, 100), -1600);
  assert.equal(wheelDelta({ grid: { cellHeight: 41 }, scale: 2 }, 3), -62);
  assert.equal(steppedOffset({ offset: 0, direction: 1, answered: 100, deltaY: -1600 }), 100);
  assert.throws(() => steppedOffset({ offset: 0, direction: 1, answered: 0, deltaY: -1600 }), /from 0 to 0, not toward older lines/);
  assert.throws(() => steppedOffset({ offset: 200, direction: -1, answered: 300, deltaY: 1600 }), /not toward newer lines/);
});

test("an action takes the last frame completed before it and the frames requested during it", { timeout: 5000 }, () => {
  const times = [[1, 2], [9, 10], [10, 12], [20, 21], [31, 32]].map(([requested, completed], i) => ({ path: `f${i}`, requested, completed }));
  assert.deepEqual(actionFrames(times, { action: "balance", from: 10, to: 30 }), { before: times[1], during: [times[2], times[3]] });
  assert.throws(() => actionFrames(times, { action: "balance", from: 0, to: 30 }), /no frame completed before balance/);
  assert.throws(() => actionFrames(times, { action: "balance", from: 22, to: 30 }), /no frame requested during balance/);
});

test("a frame is blank for a card that keeps no pixel of its colour", { timeout: 5000 }, () => {
  assert.deepEqual(blankFigures(["a", "b"], [100, 50], [[100, 0], [50, 25], [0, 50]]),
    [{ card: "a", blank: 1, fewestShare: 0 }, { card: "b", blank: 1, fewestShare: 0 }]);
  assert.throws(() => blankFigures(["a"], [0], [[0]]), /card a shows no pixel of its colour before the action/);
});

test("the leader actions run only where the build declares core.group.leader", { timeout: 5000 }, () => {
  const grid = [[{ card: "a" }, { card: "b" }, { card: "c" }]];
  assert.deepEqual(redrawActions(grid, 2, false).map(({ action }) => action), ["balance", "divider drag"]);
  assert.deepEqual(redrawActions(grid, 2, true).map(({ action }) => action), ["balance", "divider drag", "leader", "leader back"]);
});

test("the raster of a region is its frame in device pixels, also where the view rounds a half point", { timeout: 5000 }, () => {
  // host.window of a Wails window: the view of the card reports 179 by 286 points (rasterprobe.view, deviceWidth 358), while its
  // region stands 179.5 by 286.5 points wide and its frames are 359 by 573 pixels (sp_region_raster of native/darwin/src/image_region.m).
  const host = { scale: 2, regions: [
    { surface: "tab-a", name: "raster", frame: { x: 210, y: 116, width: 179.5, height: 286.5 } },
    { surface: "tab-b", name: "raster", frame: { x: 403.5, y: 116, width: 373, height: 259.5 } },
  ] };
  assert.deepEqual(regionRaster(host, "tab-a"), { width: 359, height: 573 });
  assert.deepEqual(regionRaster(host, "tab-b"), { width: 746, height: 519 });
  assert.throws(() => regionRaster(host, "tab-c"), /host.window names no image region raster of tab-c/);
});

test("the stages of a divider drag count the commit paths of its transactions and spread their times", { timeout: 5000 }, () => {
  const layout = (begun, requested, presented, committed, commitPath) => ({ ticket: begun, begun, requested, presented, committed, commitPath });
  const stages = dragStages([layout(0, 2, 4, 20, "view-join"), layout(9, 10, 12, 14, "present"), layout(18, 19, 21, 40, "view-join"),
    layout(27, null, null, null, null)]);
  assert.deepEqual(stages.paths, { "view-join": 2, present: 1, none: 1 });
  assert.deepEqual(stages.cadence.total, { count: 3, median: 20, p90: 22 });
  assert.deepEqual(stages.cadence.committing, { count: 3, median: 16, p90: 19 });
  assert.deepEqual(stages.cadence.interval, { count: 3, median: 9, p90: 9 });
});

test("the time from a press to the display of its focus counts the display periods of the refresh rate of the window", { timeout: 5000 }, () => {
  assert.deepEqual(displayFrames([8.4, 16.7, 25], 120), { count: 3, medianFrames: 2.004, p90Frames: 3, maxFrames: 3 });
  assert.deepEqual(displayFrames([33.4, 16.7], 60), { count: 2, medianFrames: 1.002, p90Frames: 2.004, maxFrames: 2.004 });
  assert.throws(() => displayFrames([10], 0), /refresh rate 0/);
});

test("the line of the drag stages names a drag without layout transactions instead of empty figures", { timeout: 5000 }, () => {
  assert.equal(stageLine(dragStages([])), "no layout transaction: the workbench drew the drag without a native layout transaction");
  const layout = (begun, committed) => ({ ticket: begun, begun, requested: begun + 1, presented: begun + 2, committed, commitPath: "present" });
  assert.match(stageLine(dragStages([layout(0, 4), layout(10, 13)])), /^transactions by commit path \{"present":2\}; interval 1 median 10\.0 p90 10\.0 ms; /);
});
