import assert from "node:assert/strict";
import test from "node:test";

import { B3_MEASUREMENTS } from "../benchmark/measurements.mjs";

test("B3_MEASUREMENTS names the B3 keys of each benchmark, and of each trace state of the view drag and the resize catch-up", { timeout: 5000 }, () => {
  assert.deepEqual(B3_MEASUREMENTS, {
    "view-drag": {
      "0": ["verdict", "peakBeforeDragKb", "peakAfterDragKb", "dragCpuSeconds"],
      "frame-records": ["dragFrameP90Ms", "dragStepP90Ms", "dragFirstFrameMs"],
    },
    "resize-catch-up": {
      "0": ["verdict"],
      "frame-records": ["maximiseFrameP90Ms", "maximiseStepP90Ms"],
    },
    "split-load": ["hostGrowthKb"],
    "idle-tab": ["idleTabCostKb", "documentPartKb"],
    "browser-view": ["verdict"],
    "editor-view": ["verdict"],
    "hwp-view": ["verdict"],
    "terminal-view": ["verdict"],
    "term-view": ["verdict"],
    "section-view": ["verdict"],
    "editor-footprint": ["verdict"],
    "input-latency": ["terminalMedianMs", "terminalP90Ms", "termMedianMs", "termP90Ms"],
  });
});

test("every B3 key of a benchmark is the verdict or a flat camelCase name that ends in its unit", { timeout: 5000 }, () => {
  const keys = Object.values(B3_MEASUREMENTS).flatMap((entry) => (Array.isArray(entry) ? entry : Object.values(entry).flat()));
  for (const key of keys) {
    assert.ok(key === "verdict" || /^[a-z][a-zA-Z0-9]*(Kb|Ms|Seconds|PerSecond)$/.test(key), `${key} is not the verdict and does not end in its unit`);
  }
  assert.ok(Object.isFrozen(B3_MEASUREMENTS) && Object.isFrozen(B3_MEASUREMENTS["view-drag"]) && Object.isFrozen(B3_MEASUREMENTS["view-drag"]["0"]));
});
