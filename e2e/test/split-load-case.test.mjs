import assert from "node:assert/strict";
import test from "node:test";

import { assertSplitLoadWithinBound, hostRssInTable, SPLIT_LOAD_GROWTH_BOUND_KB } from "../benchmark/cases/split-load.mjs";

test("the split load limit is 128 MB, and a measured growth at or above it fails the benchmark", { timeout: 5000 }, () => {
  assert.equal(SPLIT_LOAD_GROWTH_BOUND_KB, 128 * 1024);
  assert.doesNotThrow(() => assertSplitLoadWithinBound(SPLIT_LOAD_GROWTH_BOUND_KB - 1));
  assert.throws(() => assertSplitLoadWithinBound(SPLIT_LOAD_GROWTH_BOUND_KB + 1),
    /host RSS grew 131073 KB during split\/WebView stress; the bound is 131072 KB/);
});

test("the host process is found by its configuration folder in every build profile", () => {
  const table = [
    "  10 100 /work/target/release/tauriv2/soksak.app/Contents/MacOS/sok-tauriv2 --config-dir /work/other",
    "  11 200 /work/target/release/tauriv2/soksak.app/Contents/MacOS/sok-tauriv2 --config-dir /work/check",
    "  12 300 /work/target/debug/sok-wailsv3.app/Contents/MacOS/sok-wailsv3 --config-dir /work/debug",
  ].join("\n");
  assert.equal(hostRssInTable(table, "/work/check"), 200);
  assert.equal(hostRssInTable(table, "/work/debug"), 300);
  assert.equal(hostRssInTable(table, "/work/absent"), undefined);
});
