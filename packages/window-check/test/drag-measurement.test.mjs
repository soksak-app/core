import assert from "node:assert/strict";
import test from "node:test";

import { transactionCadence } from "../drag-measurement.mjs";

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
