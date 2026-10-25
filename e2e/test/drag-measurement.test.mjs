import assert from "node:assert/strict";
import test from "node:test";

import { pointerLag, transactionCadence } from "../drag-measurement.mjs";

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
