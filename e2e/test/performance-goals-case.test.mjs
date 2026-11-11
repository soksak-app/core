import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { performanceGoalBound } from "../benchmark/cases/performance-goals.mjs";

/** A goals file of the values `values` in a new folder; the folder is removed when the test ends. */
function goalsFile(t, values) {
  const folder = mkdtempSync(join(tmpdir(), "performance-goals-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "performance-goals.json");
  writeFileSync(path, JSON.stringify({ schema: 1, runs: 7, values }));
  return path;
}

test("a bound of the performance goals is read by the constant of its value", { timeout: 5000 }, (t) => {
  const path = goalsFile(t, [
    { id: "G6-S6-idle-tab-cost", constant: "IDLE_TAB_BOUND_KB", bound: { atMost: 51200 } },
    { id: "G3-S10-host-growth", constant: "SPLIT_LOAD_GROWTH_BOUND_KB", bound: { below: 131072 } },
    { id: "G8-S5-drag-frame-p90", periods: { atMost: 1 } },
  ]);
  assert.equal(performanceGoalBound("IDLE_TAB_BOUND_KB", "atMost", path), 51200);
  assert.equal(performanceGoalBound("SPLIT_LOAD_GROWTH_BOUND_KB", "below", path), 131072);
});

test("a constant that no value or two values name, or a bound of another kind, is an error that names it", { timeout: 5000 }, (t) => {
  const path = goalsFile(t, [
    { id: "a", constant: "TWICE_KB", bound: { atMost: 1 } },
    { id: "b", constant: "TWICE_KB", bound: { atMost: 2 } },
    { id: "c", constant: "BELOW_KB", bound: { below: 3 } },
    { id: "d", constant: "TEXT_KB", bound: { atMost: "4" } },
  ]);
  assert.throws(() => performanceGoalBound("ABSENT_KB", "atMost", path),
    new Error(`${path}: 0 values have the constant ABSENT_KB; exactly one must have it`));
  assert.throws(() => performanceGoalBound("TWICE_KB", "atMost", path),
    new Error(`${path}: 2 values have the constant TWICE_KB; exactly one must have it`));
  assert.throws(() => performanceGoalBound("BELOW_KB", "atMost", path),
    new Error(`${path}: the bound of c (BELOW_KB) has no finite atMost: {"below":3}`));
  assert.throws(() => performanceGoalBound("TEXT_KB", "atMost", path),
    new Error(`${path}: the bound of d (TEXT_KB) has no finite atMost: {"atMost":"4"}`));
});
