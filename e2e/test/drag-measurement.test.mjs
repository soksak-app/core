import assert from "node:assert/strict";
import test from "node:test";

import { transactionCadence } from "../drag-measurement.mjs";

test("the transaction cadence reports the start intervals and the time to presentation", () => {
  const cadence = transactionCadence([
    { begun: 0, presented: 30 },
    { begun: 33, presented: 63 },
    { begun: 50, presented: null },
    { begun: 66, presented: 97 },
  ]);
  assert.deepEqual(cadence.interval, { count: 3, median: 17, p90: 33 });
  assert.deepEqual(cadence.presenting, { count: 3, median: 30, p90: 31 });
});
