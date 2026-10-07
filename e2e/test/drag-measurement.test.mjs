import assert from "node:assert/strict";
import test from "node:test";

import { transactionCadence } from "../drag-measurement.mjs";

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
