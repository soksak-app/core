import assert from "node:assert/strict";
import test from "node:test";

import { heapTotals, measure } from "../measure-host-allocations.mjs";

test("the totals are the nodes and bytes of the line of all zones, and output without it is an error", () => {
  assert.deepEqual(heapTotals("Process 7: 9 zones\nAll zones: 77466 nodes malloced - Sizes: 32[1]\nAll zones: 77466 nodes (18570120 bytes)\n"),
    { nodes: 77466, bytes: 18570120 });
  assert.throws(() => heapTotals("heap: no such process"), /heap printed no line "All zones: N nodes \(B bytes\)": heap: no such process/);
});

test("the measurement records the start and each minute with the totals of the process", async () => {
  const entries = [];
  let clock = 0;
  let calls = 0;
  await measure({
    pid: 7, minutes: 2,
    totals: () => ({ nodes: ++calls, bytes: calls * 10 }),
    wait: async (ms) => { clock += ms; },
    log: (entry) => entries.push(entry),
    now: () => clock,
  });
  assert.deepEqual(entries, [
    { phase: "start", elapsedMs: 0, pid: 7, nodes: 1, bytes: 10 },
    { phase: "minute 1", elapsedMs: 60000, pid: 7, nodes: 2, bytes: 20 },
    { phase: "minute 2", elapsedMs: 120000, pid: 7, nodes: 3, bytes: 30 },
  ]);
});
