import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { B3_MEASUREMENTS } from "../benchmark/measurements.mjs";
import { assertIdleTabWithinBound, IDLE_TAB_BOUND_KB, idleTabB3Values, idleTabGrowth, settledDocumentsOf } from "../benchmark/cases/idle-tab.mjs";

const GOALS = JSON.parse(readFileSync(new URL("../../docs/spec/performance-goals.json", import.meta.url), "utf8"));

test("the idle tab limit is the bound of IDLE_TAB_BOUND_KB in the performance goals, and a measured cost above it fails the benchmark",
  { timeout: 5000 }, () => {
    const bound = GOALS.values.find((value) => value.constant === "IDLE_TAB_BOUND_KB").bound.atMost;
    assert.equal(IDLE_TAB_BOUND_KB, bound);
    const measurement = { settled: 29040, growthOf: "main web view", growthBefore: 1000, growthAfter: 1000 + 24768, growth: 24768 };
    assert.doesNotThrow(() => assertIdleTabWithinBound({ ...measurement, cost: bound }));
    assert.throws(() => assertIdleTabWithinBound({ ...measurement, cost: bound + 1 }),
      new Error(`the idle tab costs ${bound + 1} KB: documents 29040 KB plus main web view growth 24768 KB is over ${bound} KB`));
    assert.throws(() => assertIdleTabWithinBound({ ...measurement, growthOf: "host process", cost: bound + 1 }),
      new Error(`the idle tab costs ${bound + 1} KB: documents 29040 KB plus host process growth 24768 KB is over ${bound} KB`));
  });

test("the documents of a tab are counted once each footprint is settled", { timeout: 5000 }, () => {
  const match = (fields) => fields.role === "document";
  const settled = settledDocumentsOf("the documents of tab", match)([
    { role: "document", document: "a", footprint_kb: 20000 },
    { role: "document", document: "a", footprint_kb: 20100 },
    { role: "document", document: "b", footprint_kb: 9000 },
    { role: "document", document: "b", footprint_kb: 9050 },
    { role: "page", document: "c", footprint_kb: 1 },
  ]);
  assert.equal(settled.value, 20100 + 9050);
  const unsettled = settledDocumentsOf("the documents of tab", match)([
    { role: "document", document: "a", footprint_kb: 20000 },
    { role: "document", document: "a", footprint_kb: 30000 },
  ]);
  assert.equal(unsettled.value, undefined);
});

// The sampler rows of the mygo host: no page row, the reading of the host process and the documents of the tab.
const MYGO_ROWS = [
  { rss_host_kb: 90000, footprint_kb: 40000 },
  { role: "document", window: "w1", surface: "s1", document: "", pid: 501, footprint_kb: 12000 },
  { rss_host_kb: 90100, footprint_kb: 40500 },
];
const PAGE_ROWS = [
  { role: "page", window: "w1", pid: 400, footprint_kb: 70000 },
  { rss_host_kb: 90000, footprint_kb: 40000 },
  { role: "page", window: "w1", pid: 400, footprint_kb: 70200 },
  { role: "page", window: "w2", pid: 410, footprint_kb: 1 },
];

test("the idle tab counts the growth of the host process for a window without a page process", { timeout: 5000 }, () => {
  const growth = idleTabGrowth({ window: "w1", pageProcess: null });
  assert.equal(growth.of, "host process");
  assert.deepEqual(growth.settled(MYGO_ROWS), { value: 40500, state: "readings of the host process: 40000 40500 KB" });
  assert.equal(growth.settled(MYGO_ROWS.slice(0, 2)).value, undefined);
});

test("the idle tab counts the growth of the main web view for a window with a page process", { timeout: 5000 }, () => {
  const growth = idleTabGrowth({ window: "w1", pageProcess: 400 });
  assert.equal(growth.of, "main web view");
  assert.deepEqual(growth.settled(PAGE_ROWS), { value: 70200, state: "readings of the main web view of w1: 70000 70200 KB" });
  assert.throws(() => idleTabGrowth({ window: "w1", pageProcess: undefined }),
    new Error("host.window of w1 reports pageProcess undefined, neither a process id nor null"));
});

test("the B3 values of an idle tab are its cost and its document part in KB, the keys that B3_MEASUREMENTS declares", { timeout: 5000 }, () => {
  const values = idleTabB3Values({ settled: 29040, growthOf: "host process", growthBefore: 1000, growthAfter: 3000, growth: 2000, cost: 31040 });
  assert.deepEqual(values, { idleTabCostKb: 31040, documentPartKb: 29040 });
  assert.deepEqual(Object.keys(values), B3_MEASUREMENTS["idle-tab"]);
});
