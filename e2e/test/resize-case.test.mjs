import assert from "node:assert/strict";
import test from "node:test";

import { assertCatchUpWithinBound, CATCH_UP_LIMIT_MS } from "../benchmark/cases/resize.mjs";

test("the catch-up limit of a maximise or restore is 150 ms, and a measured time above it fails the benchmark", { timeout: 5000 }, () => {
  assert.equal(CATCH_UP_LIMIT_MS, 150);
  assert.doesNotThrow(() => assertCatchUpWithinBound(150, "maximising"));
  assert.doesNotThrow(() => assertCatchUpWithinBound(0, "restoring"));
  assert.throws(() => assertCatchUpWithinBound(151, "maximising"),
    /maximising: the layout stayed behind the window for 151ms, more than 150ms/);
});
