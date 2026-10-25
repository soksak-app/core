import assert from "node:assert/strict";
import test from "node:test";

import * as measurement from "../drag-measurement.mjs";
const { assertDragFrameCadence, pointerLag, transactionCadence } = measurement;

test("the transaction cadence reports the start intervals and the time to presentation", () => {
  const cadence = transactionCadence([
    { begun: 0, requested: 14, presented: 30 },
    { begun: 33, requested: 48, presented: 63 },
    { begun: 50, requested: null, presented: null },
    { begun: 66, requested: 82, presented: 97 },
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
    { time: 0, position: 10 }, { time: 9, position: 10 },
  ], [10], [10, 20]), /drag measurement/);
});

test("pointer lag rejects a non-finite captured timestamp", { timeout: 1000 }, () => {
  assert.throws(() => pointerLag([
    { time: 0, position: 10 }, { time: NaN, position: 20 },
  ], [10], [10, 20]), /drag samples/);
});

test("pointer lag measures finite frames after input", { timeout: 1000 }, () => {
  assert.deepEqual(pointerLag([
    { time: 0, position: 10 }, { time: 11, position: 10 }, { time: 12, position: 20 },
  ], [10], [10, 20]), { lag: 1, time: 11, shown: 0, step: -1, sent: 0, median: 1, p90: 1 });
});


test("view drag cadence requires every frame within 33 milliseconds", { timeout: 1000 }, () => {
  assert.equal(assertDragFrameCadence([0, 16, 49, 65]), 33);
  assert.throws(() => assertDragFrameCadence([0, 16, 49.01, 65]), /33.*gap|gap.*33/);
});

test("view drag cadence rejects missing or invalid frame times", { timeout: 1000 }, () => {
  for (const times of [[], [0], [0, NaN], [0, Infinity], [0, 0], [1, 0]]) {
    assert.throws(() => assertDragFrameCadence(times), /frame times/);
  }
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
  assert.throws(() => measurement.assertDragFrameCadence([0, 34, 68]), /exceeds 33ms/);
});


test("drag performance keeps existing targets separate from valid measurements", { timeout: 1000 }, () => {
  assert.equal(typeof measurement.measureDragPerformance, "function", "separate performance results are required");
  const report = measurement.measureDragPerformance([0, 34, 68], { lag: 100, median: 40, p90: 70 }, 60);
  assert.deepEqual(report.exceeded, ["cadence", "p90", "worst"]);
  assert.throws(() => measurement.assertDragPerformance([0, 34, 68], { lag: 100, median: 40, p90: 70 }, 60),
    /performance targets/);
  assert.equal(measurement.assertDragPerformance([0, 16, 32], { lag: 20, median: 10, p90: 15 }, 120).targetsMet, true);
  assert.throws(() => measurement.measureDragPerformance([0, 16], { lag: NaN, median: 1, p90: 2 }, 60), /latency/);
  assert.throws(() => measurement.measureDragPerformance([0, 16], { lag: 1, median: 1, p90: 1 }, 0), /refresh/);
});
