import assert from "node:assert/strict";
import test from "node:test";

import {
  catchUp, commitCadence, contentAfterChange, contentCadence, contentConvergence, displayPeriod, lastInputLatency, sentAt,
  stepCommitDelays,
} from "../layout-timing.mjs";

/** A layout transaction begun at `begun` and sent to the render server at `committed` (ms), with the path `commitPath`. */
const layout = (ticket, begun, committed, { flushed = null, commitPath = committed === null ? null : "present" } = {}) =>
  ({ ticket, begun, requested: null, presented: null, committed, commitPath, openAtCommit: committed === null ? null : 0, flushed });

/** A content frame of a view drawn at `at` (ms on the host clock) at the size `width` x `height`. */
const frame = (at, width, height = 300) => ({ frameTimeMs: at, width, height, timeRange: { lowerMs: at - 1, upperMs: at + 1 } });

test("the display period is the time of one refresh of the display", () => {
  assert.equal(displayPeriod(120), 1000 / 120);
  assert.equal(displayPeriod(60), 1000 / 60);
  assert.throws(() => displayPeriod(null), /refresh rate/);
  assert.throws(() => displayPeriod(0), /refresh rate/);
});

test("a layout is sent at its commit, or at the flush of the transaction that held its commit", () => {
  assert.equal(sentAt(layout(1, 0, 10)), 10);
  assert.equal(sentAt(layout(1, 0, 10, { flushed: 14 })), 14);
  assert.equal(sentAt(layout(1, 0, 10, { flushed: 9 })), 10);
  assert.equal(sentAt(layout(1, 0, null)), null);
  assert.equal(sentAt(layout(1, 0, 10, { commitPath: "cancel" })), null);
});

test("view-drag commits follow one another within two display periods", () => {
  const period = 1000 / 60;
  const passed = commitCadence([layout(1, 0, 10), layout(2, 17, 30), layout(3, 34, 60), layout(4, 200, 210)],
    { from: 0, to: 40, period });
  assert.deepEqual(passed.intervals, [20, 30]);
  assert.equal(passed.limit, 2 * period);
  assert.deepEqual(passed.failures, []);

  const late = commitCadence([layout(1, 0, 10), layout(2, 17, 50)], { from: 0, to: 40, period });
  assert.deepEqual(late.failures, [`the commit at 50 ms followed the commit before it after 40 ms, more than ${2 * period} ms`]);

  assert.deepEqual(commitCadence([layout(1, 0, 10)], { from: 0, to: 40, period }).failures,
    ["the drag committed 1 layouts from 0 to 40 ms, fewer than 2"]);
});

test("a divider drag commits each step within four display periods, with a median of 2.5 and a 90th percentile of 3", () => {
  const period = 10;
  const passed = stepCommitDelays([layout(1, 0, 20), layout(2, 10, 35), layout(3, 20, 40), layout(4, 30, 40, { commitPath: "cancel" })],
    { from: 0, to: 30, period });
  assert.deepEqual(passed.delays, [2, 2.5, 2]);
  assert.deepEqual([passed.median, passed.p90, passed.longest], [2, 2.5, 2.5]);
  assert.deepEqual(passed.failures, []);

  const slow = stepCommitDelays([layout(1, 0, 45), layout(2, 10, 41), layout(3, 20, 51)], { from: 0, to: 30, period });
  assert.deepEqual(slow.failures, [
    "the layout of ticket 1 committed 4.5 display periods after it began, more than 4",
    "the median delay is 3.1 display periods, more than 2.5",
    "the 90th percentile delay is 4.5 display periods, more than 3",
  ]);

  assert.deepEqual(stepCommitDelays([layout(1, 0, 20), layout(2, 10, null)], { from: 0, to: 30, period }).failures,
    ["the layout of ticket 2 began at 10 ms and did not commit"]);
  assert.deepEqual(stepCommitDelays([layout(1, 50, 60)], { from: 0, to: 30, period }).failures,
    ["no layout began from 0 to 30 ms"]);
});

test("the layout of the last input of a drag follows the layout pipeline", () => {
  const period = 10;
  // Ticket 2 was in flight at the last input and presented at 104; ticket 3, the layout of the last input, began at the next animation
  // frame and was sent 5 display periods after that presentation.
  const inFlight = { ...layout(2, 92, 112), presented: 104 };
  assert.deepEqual(lastInputLatency([layout(1, 0, 10), inFlight, layout(3, 114, 154)], { lastInput: 100, period }),
    { inFlight: 2, from: 104, ticket: 3, begun: 114, sent: 154, delay: 50, limit: 50, failures: [] });
  // With no layout in flight the pipeline starts at the input.
  assert.deepEqual(lastInputLatency([layout(1, 0, 10), layout(2, 108, 140)], { lastInput: 100, period }),
    { inFlight: null, from: 100, ticket: 2, begun: 108, sent: 140, delay: 40, limit: 50, failures: [] });
  // A last input that began no layout keeps the layout in flight, or the one sent before the input.
  assert.deepEqual(lastInputLatency([layout(1, 0, 10), layout(2, 92, 115)], { lastInput: 100, period }).failures, []);
  assert.deepEqual(lastInputLatency([layout(1, 0, 10)], { lastInput: 100, period }).failures, []);
  // A cancelled layout was replaced and is not the layout of the last input.
  const replaced = [layout(1, 101, 105, { commitPath: "cancel" }), layout(2, 106, 130)];
  assert.equal(lastInputLatency(replaced, { lastInput: 100, period }).ticket, 2);

  assert.deepEqual(lastInputLatency([layout(1, 0, 10), layout(2, 112, 151)], { lastInput: 100, period }).failures,
    ["the layout of the last input was sent 51 ms after the last input, more than 50 ms"]);
  assert.deepEqual(lastInputLatency([inFlight, layout(3, 116, 155)], { lastInput: 100, period }).failures,
    ["the layout of the last input was sent 51 ms after the presentation of ticket 2 in flight at the last input, more than 50 ms"]);
  assert.deepEqual(lastInputLatency([layout(1, 0, 10), layout(2, 101, 145)], { lastInput: 100, period }).failures,
    ["the layout of ticket 2 was sent 4.4 display periods after it began, more than 4"]);
  assert.deepEqual(lastInputLatency([layout(1, 0, 10), layout(2, 60, 105)], { lastInput: 100, period }).failures,
    ["the layout of ticket 2 was sent 4.5 display periods after it began, more than 4"]);
  assert.deepEqual(lastInputLatency([layout(1, 0, 10), layout(2, 101, null)], { lastInput: 100, period }).failures,
    ["the layout of ticket 2 began at 101 ms and was not sent"]);
  assert.deepEqual(lastInputLatency([layout(1, 0, null)], { lastInput: 100, period }).failures,
    ["the drag sent no layout", "the layout of ticket 1 began at 0 ms and was not sent"]);
});

test("a maximise or restore catches up with the window within 150 ms of its first resize", () => {
  const layouts = [layout(1, 5, 20), layout(2, 60, 80), layout(3, 101, 130), layout(4, 140, 400)];
  assert.deepEqual(catchUp(layouts, [0, 50, 100]), { took: 130, limit: 150, ticket: 3, failures: [] });
  assert.deepEqual(catchUp(layouts.slice(0, 2).concat(layout(3, 101, 160)), [0, 50, 100]).failures,
    ["the layout at the window size was sent 160 ms after the first resize, more than 150 ms"]);
  assert.deepEqual(catchUp(layouts.slice(0, 2), [0, 50, 100]).failures,
    ["no layout began after the last resize at 100 ms"]);
  assert.deepEqual(catchUp(layouts, []).failures, ["the gesture has no window resize"]);
});

test("the content frames of a view drag follow one another within 40 ms", () => {
  const frames = [frame(0, 100), frame(100, 110), frame(130, 120), frame(165, 130), frame(500, 130)];
  assert.deepEqual(contentCadence(frames, { from: 100, to: 170 }), { count: 3, intervals: [30, 35], limit: 40, failures: [] });
  assert.deepEqual(contentCadence([frame(100, 110), frame(150, 120)], { from: 100, to: 170 }).failures,
    ["the content frame at 150 ms followed the frame before it after 50 ms, more than 40 ms"]);
  assert.deepEqual(contentCadence([frame(100, 110)], { from: 100, to: 170 }).failures,
    ["the view drew 1 content frames during the drag, fewer than 2"]);
});

test("the view draws its final size within 40 ms after the drag when that size differs from the last size of the drag", () => {
  assert.deepEqual(contentConvergence([frame(90, 100), frame(110, 120), frame(130, 140)], { end: 100 }),
    { applicable: true, took: 31, limit: 40, failures: [] });
  assert.deepEqual(contentConvergence([frame(90, 100), frame(150, 140)], { end: 100 }).failures,
    ["the view drew its final size 51 ms after the drag, more than 40 ms"]);
  assert.deepEqual(contentConvergence([frame(90, 140), frame(150, 140)], { end: 100 }),
    { applicable: false, took: null, limit: 40, failures: [] });
  assert.deepEqual(contentConvergence([frame(120, 140)], { end: 100 }).failures, ["the view drew no content frame during the drag"]);
});

test("a card layout change shows the content at the new size within 100 ms", () => {
  assert.deepEqual(contentAfterChange([frame(0, 100), frame(40, 100), frame(80, 180), frame(90, 180)], { began: 20, changedAt: 20 }),
    { took: 61, limit: 100, failures: [] });
  assert.deepEqual(contentAfterChange([frame(0, 100), frame(140, 180)], { began: 20, changedAt: 20 }).failures,
    ["the view drew its new size 121 ms after the change, more than 100 ms"]);
  assert.deepEqual(contentAfterChange([frame(0, 100), frame(40, 100)], { began: 20, changedAt: 20 }).failures,
    ["the view drew no new size after the change"]);
  assert.deepEqual(contentAfterChange([frame(40, 180)], { began: 20, changedAt: 20 }).failures,
    ["the view drew no content frame before the change"]);
});

test("a content frame of a card change drawn before its first layout was sent belongs to the change", () => {
  // The change began at 20 and its first layout was sent at 50; the view drew the new size at 40, before the sending.
  const frames = [frame(0, 100), frame(40, 180)];
  assert.deepEqual(contentAfterChange(frames, { began: 20, changedAt: 50 }), { took: -9, limit: 100, failures: [] });
  // That frame is not a frame of the drag that ended at 10: the drag kept its last size.
  assert.deepEqual(contentConvergence(frames.filter(({ timeRange }) => timeRange.upperMs < 20), { end: 10 }),
    { applicable: false, took: null, limit: 40, failures: [] });
});
