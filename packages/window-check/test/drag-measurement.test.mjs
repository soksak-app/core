import assert from "node:assert/strict";
import test from "node:test";

import * as measurement from "../drag-measurement.mjs";
const { assertDragFrameCadence, pointerLag, transactionCadence } = measurement;

// A window that stays on one display for the whole recording.
const steady = (period) => ({ times: [0], periods: [period] });

/**
 * The still rows (readStills of stills.jsonl) of a recording that plans a still every `gap` ms from 0 until `until`, each
 * written 0.5ms after its request, except the indices of `failed`, `notRequested` and `lateBy` (index: ms late).
 */
const stillRows = ({ gap = 8, until, failed = [], notRequested = [], lateBy = {} }) =>
  Array.from({ length: Math.floor(until / gap) + 1 }, (_, index) => {
    const planned = index * gap;
    if (notRequested.includes(index)) {
      return { index, planned, requested: null, completed: null, gap, outcome: "not-requested", error: null, late: false };
    }
    const requested = planned + (lateBy[index] ?? 0);
    return { index, planned, requested, completed: requested + 0.5, gap, outcome: failed.includes(index) ? "failed" : "written",
      error: failed.includes(index) ? "the window server returned no image" : null, late: requested - planned > gap };
  });

test("the transaction cadence reports the start intervals and the time to presentation", () => {
  const cadence = transactionCadence([
    { begun: 0, requested: 14, presented: 30, committed: 65 },
    { begun: 33, requested: 48, presented: 63, committed: 82 },
    { begun: 50, requested: null, presented: null, committed: null },
    { begun: 66, requested: 82, presented: 97, committed: 114 },
  ]);
  assert.deepEqual(cadence.interval, { count: 3, median: 17, p90: 33 });
  assert.deepEqual(cadence.presenting, { count: 3, median: 30, p90: 31 });
  assert.deepEqual(cadence.drawing, { count: 3, median: 15, p90: 16 });
  assert.deepEqual(cadence.waiting, { count: 3, median: 15, p90: 16 });
});

test("pointer lag rejects no captured frames", { timeout: 1000 }, () => {
  assert.throws(() => pointerLag([], [10], [10, 20]), /drag samples/);
});

test("pointer lag rejects only frames before input", { timeout: 1000 }, () => {
  assert.throws(() => pointerLag([
    { time: 0, completed: 0.5, position: 10 }, { time: 9, completed: 9.5, position: 10 },
  ], [10], [10, 20]), /drag measurement/);
});

test("pointer lag rejects a non-finite completion time of a still", { timeout: 1000 }, () => {
  assert.throws(() => pointerLag([
    { time: 0, completed: 0.5, position: 10 }, { time: 12, completed: NaN, position: 20 },
  ], [10], [10, 20]), /drag samples/);
  assert.throws(() => pointerLag([
    { time: 0, completed: 0.5, position: 10 }, { time: 12, position: 20 },
  ], [10], [10, 20]), /drag samples/);
});

// A still shows the window at one moment between its request and its completion, so a layout that it shows was left no later
// than its completion: the lag of a still runs from the step that left its layout to its completion.
test("pointer lag measures each still after input up to its completion", { timeout: 1000 }, () => {
  assert.deepEqual(pointerLag([
    { time: 0, completed: 0.5, position: 10 }, { time: 11, completed: 12.5, position: 10 }, { time: 13, completed: 13.5, position: 20 },
  ], [10], [10, 20]), { lag: 2.5, time: 12.5, shown: 0, step: -1, sent: 0, median: 2.5, medianTime: 12.5, p90: 2.5, p90Time: 12.5 });
});


test("view drag cadence requires every frame within two display periods", { timeout: 1000 }, () => {
  const stills = stillRows({ until: 80 });
  assert.equal(assertDragFrameCadence([0, 16, 51, 67], steady(17.5), stills), 35);
  assert.throws(() => assertDragFrameCadence([0, 16, 51.01, 67], steady(17.5), stills), /35.*gap|gap.*35/);
  assert.throws(() => assertDragFrameCadence([0, 17, 34], steady(8.33), stills), /exceeds 16\.660ms/);
});

test("view drag cadence rejects missing or invalid frame times", { timeout: 1000 }, () => {
  for (const times of [[], [0], [0, NaN], [0, Infinity], [0, 0], [1, 0]]) {
    assert.throws(() => assertDragFrameCadence(times, steady(8), stillRows({ until: 8 })), /frame times/);
  }
});

// A still lost at a gap of one refresh leaves an interval of two refreshes, which the bound of two periods passes: the cadence
// reads the still rows of its span and fails on any still that wrote no frame or that was requested later than one gap.
test("view drag cadence fails on a still that the recording lost in its span", { timeout: 1000 }, () => {
  const times = [0, 8, 24, 32];
  assert.throws(() => assertDragFrameCadence(times, steady(8), stillRows({ until: 40, failed: [2] })),
    /^AssertionError \[ERR_ASSERTION\]: view drag recording lost 1 stills between 0\.0ms and 32\.0ms: still 2 planned at 16\.0ms failed \(the window server returned no image\)$/);
  assert.throws(() => assertDragFrameCadence([0, 8, 16, 32], steady(8), stillRows({ until: 40, notRequested: [3], lateBy: { 1: 9 } })),
    /lost 2 stills between 0\.0ms and 32\.0ms: still 1 planned at 8\.0ms was requested 9\.0ms late, still 3 planned at 24\.0ms was not requested$/);
  // A still lost outside the span, and the stills that the stop left unrequested, are not in the cadence.
  assert.equal(assertDragFrameCadence(times.slice(0, 2), steady(8), stillRows({ until: 40, failed: [2], notRequested: [4, 5] })), 8);
  assert.throws(() => assertDragFrameCadence(times, steady(8)), /still rows/);
});


test("final content size reaches the card edges by the second captured frame", { timeout: 1000 }, () => {
  assert.equal(typeof measurement.assertFinalContentSize, "function", "final content size measurement is required");
  assert.deepEqual(measurement.assertFinalContentSize([
    { time: 9, left: 1, right: 40 },
    { time: 11, left: 1, right: 20 },
    { time: 12, left: 1, right: 2 },
    { time: 13, left: 1, right: 1 },
  ], 10), { frames: 3, settledFrame: 2 });
});

test("final content size rejects a late correction and a later regression", { timeout: 1000 }, () => {
  for (const edges of [[20, 20, 1], [1, 1, 20]]) {
    assert.throws(() => measurement.assertFinalContentSize(edges.map((right, index) =>
      ({ time: 11 + index, left: 1, right })), 10), /final content.*frame/);
  }
});

test("final content size rejects missing post-input evidence", { timeout: 1000 }, () => {
  assert.throws(() => measurement.assertFinalContentSize([{ time: 11, left: 1, right: 1 }], 10),
    /two.*post-input/);
  assert.throws(() => measurement.assertFinalContentSize([
    { time: 11, left: 1, right: 1 }, { time: 12, left: null, right: null },
  ], 10), /geometry/);
});


test("drag cadence measurement retains intervals beyond the performance target", { timeout: 1000 }, () => {
  assert.equal(typeof measurement.measureDragFrameCadence, "function", "separate cadence measurement is required");
  assert.equal(measurement.measureDragFrameCadence([0, 34, 68]), 34);
  assert.throws(() => measurement.measureDragFrameCadence([0, 0]), /frame times/);
  assert.throws(() => measurement.assertDragFrameCadence([0, 36, 72], steady(17.5), stillRows({ until: 80 })), /exceeds 35\.000ms/);
});


test("drag performance keeps existing targets separate from valid measurements", { timeout: 1000 }, () => {
  assert.equal(typeof measurement.measureDragPerformance, "function", "separate performance results are required");
  const stills = stillRows({ until: 80 });
  const report = measurement.measureDragPerformance([0, 36, 72], { lag: 100, time: 72, median: 40, medianTime: 36, p90: 70, p90Time: 72 }, steady(1000 / 60), stills);
  assert.deepEqual(report.exceeded, ["cadence", "p90", "worst"]);
  assert.throws(() => measurement.assertDragPerformance([0, 36, 72], { lag: 100, time: 72, median: 40, medianTime: 36, p90: 70, p90Time: 72 }, steady(1000 / 60), stills),
    /performance targets/);
  assert.equal(measurement.assertDragPerformance([0, 16, 32], { lag: 20, time: 32, median: 10, medianTime: 16, p90: 15, p90Time: 32 }, steady(1000 / 120), stills).targetsMet, true);
  assert.throws(() => measurement.measureDragPerformance([0, 16], { lag: NaN, median: 1, p90: 2 }, steady(1000 / 60), stills), /latency/);
  assert.throws(() => measurement.measureDragPerformance([0, 16], { lag: 1, time: 1, median: 1, medianTime: 1, p90: 1, p90Time: 1 }, steady(0), stills), /display period/);
});

test("drag performance states the median interval of the shown frames", { timeout: 1000 }, () => {
  const lag = { lag: 20, time: 24, median: 10, medianTime: 8, p90: 15, p90Time: 16 };
  const stills = stillRows({ until: 80 });
  assert.equal(measurement.measureDragPerformance([0, 8, 16, 24], lag, steady(1000 / 120), stills).frameInterval, 8);
  assert.equal(measurement.measureDragPerformance([0, 17, 33, 50, 67], lag, steady(1000 / 120), stills).frameInterval, 17);
});

// The performance of a drag judges its cadence by its shown frames and by the still rows of its span: a still lost in it misses
// the cadence target and is named in the report.
test("drag performance misses its cadence on a still that the recording lost in its span", { timeout: 1000 }, () => {
  const lag = { lag: 8, time: 24, median: 8, medianTime: 8, p90: 8, p90Time: 16 };
  const report = measurement.measureDragPerformance([0, 8, 24], lag, steady(1000 / 120), stillRows({ until: 40, failed: [2] }));
  assert.deepEqual(report.exceeded, ["stills"]);
  assert.deepEqual(report.lost, ["still 2 planned at 16.0ms failed (the window server returned no image)"]);
  assert.throws(() => measurement.assertDragPerformance([0, 8, 24], lag, steady(1000 / 120), stillRows({ until: 40, failed: [2] })),
    /performance targets exceeded: .*"lost":\["still 2 planned at 16\.0ms failed/);
  assert.deepEqual(measurement.measureDragPerformance([0, 8, 16, 24], lag, steady(1000 / 120), stillRows({ until: 40 })).lost, []);
  assert.throws(() => measurement.measureDragPerformance([0, 8, 24], lag, steady(1000 / 120)), /still rows/);
});

test("transaction cadence includes commit waiting and total transaction duration", { timeout: 1000 }, () => {
  const report = transactionCadence([
    { begun: 0, requested: 14, presented: 30, committed: 65 },
    { begun: 33, requested: 48, presented: 63, committed: 82 },
    { begun: 50, requested: null, presented: null, committed: null },
    { begun: 66, requested: 82, presented: 97, committed: 114 },
  ]);
  assert.deepEqual(report.committing, { count: 3, median: 19, p90: 35 });
  assert.deepEqual(report.total, { count: 3, median: 49, p90: 65 });
});

test("transaction cadence rejects invalid or reversed stage timestamps", { timeout: 1000 }, () => {
  assert.throws(() => transactionCadence([
    { begun: 0, requested: 14, presented: 30, committed: Infinity },
  ]), /committed.*finite/);
  assert.throws(() => transactionCadence([
    { begun: 0, requested: 14, presented: 30, committed: 20 },
  ]), /committed.*before/);
});

test("drag cadence reads the shown frames from the first input", { timeout: 1000 }, () => {
  const samples = [{ time: 10, position: 0 }, { time: 80, position: 10 }, { time: 96, position: 20 }];
  assert.deepEqual(measurement.shownTimes(samples, [70, 86]), [80, 96]);
  assert.throws(() => measurement.shownTimes(samples, []), /no step times/);
});

// After the display of the last step the window has nothing to show, so the time until the recording stops is no gap of the
// drag: the cadence ends at the first shown frame at or after the last step.
test("drag cadence ends at the first shown frame after the last step", { timeout: 1000 }, () => {
  const samples = [{ time: 10, position: 0 }, { time: 80, position: 10 }, { time: 96, position: 20 }, { time: 104, position: 10 },
    { time: 480, position: 11 }];
  assert.deepEqual(measurement.shownTimes(samples, [70, 86, 100]), [80, 96, 104]);
});


test("view drag gaps and latency are judged by the display period at their own time", { timeout: 1000 }, () => {
  // The window is on a 120 Hz display until 200ms, then on a 60 Hz display.
  const fast = 1000 / 120;
  const slow = 1000 / 60;
  const refreshes = {
    times: [...Array.from({ length: 25 }, (_, index) => index * fast), ...Array.from({ length: 6 }, (_, index) => 216.7 + index * slow)],
    periods: [...Array.from({ length: 25 }, () => fast), ...Array.from({ length: 6 }, () => slow)],
  };
  // The stills were requested every 20ms.
  const stills = stillRows({ gap: 20, until: 260 });
  // A 20ms gap is within two periods of the 60 Hz display, but not of the 120 Hz display.
  assert.equal(measurement.assertDragFrameCadence([200, 220, 240], refreshes, stills), 20);
  // A 40ms gap at 240ms exceeds two periods of the 60 Hz display.
  assert.throws(() => measurement.assertDragFrameCadence([200, 240], refreshes, stills), /exceeds 33\.333ms/);
  // A 40ms median at 230ms is within 2.5 periods of the 60 Hz display, but not of the 120 Hz display.
  const lag = { lag: 40, time: 230, median: 40, medianTime: 230, p90: 40, p90Time: 230 };
  assert.deepEqual(measurement.measureDragPerformance([200, 220, 240], lag, refreshes, stills).exceeded, []);
});

// A layout held for HOLD or longer that the recording does not show fails whatever lost it; when the recording lost stills in
// the time of the missing layouts, the failure names them, so a loss of the recording is told from a layout never shown.
test("a missing held layout names the stills that the recording lost in its time", { timeout: 1000 }, () => {
  const ticks = [10, 60];
  const boundary = [0, 20, 0];
  const samples = [{ time: 0, position: 0 }, { time: 8, position: 0 }, { time: 64, position: 0 }];
  assert.throws(() => measurement.assertHeldStatesShown(samples, ticks, boundary, stillRows({ until: 72, failed: [2, 3], lateBy: { 5: 10 } })),
    /layouts held for 34ms or longer are missing from the recording: 20 held 10\.0\.\.60\.0; the recording lost 3 stills in that time: still 2 planned at 16\.0ms failed \(the window server returned no image\), still 3 planned at 24\.0ms failed \(the window server returned no image\), still 5 planned at 40\.0ms was requested 10\.0ms late; steps at /);
  assert.throws(() => measurement.assertHeldStatesShown(samples, ticks, boundary, stillRows({ until: 72 })),
    /missing from the recording: 20 held 10\.0\.\.60\.0; the recording lost no still in that time; steps at /);
  assert.throws(() => measurement.assertHeldStatesShown(samples, ticks, boundary), /still rows/);
});
