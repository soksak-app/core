import assert from "node:assert/strict";
import test from "node:test";

import { assertSplitLoadWithinBound, SPLIT_LOAD_GROWTH_BOUND_KB } from "../benchmark/cases/split-load.mjs";

test("the split load limit is 128 MB, and a measured growth at or above it fails the benchmark", { timeout: 5000 }, () => {
  assert.equal(SPLIT_LOAD_GROWTH_BOUND_KB, 128 * 1024);
  assert.doesNotThrow(() => assertSplitLoadWithinBound(SPLIT_LOAD_GROWTH_BOUND_KB - 1));
  assert.throws(() => assertSplitLoadWithinBound(SPLIT_LOAD_GROWTH_BOUND_KB + 1),
    /host RSS grew 131073 KB during split\/WebView stress; the bound is 131072 KB/);
});
