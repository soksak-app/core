import assert from "node:assert/strict";
import test from "node:test";

import { FRAME_RECORDS, traceSettings } from "../../scripts/measure-trace.mjs";
import { B3_MEASUREMENTS, B3_SETTINGS } from "../benchmark/measurements.mjs";

test("B3_MEASUREMENTS names the B3 keys of each benchmark, and of each trace state of the view drag and the resize catch-up", { timeout: 5000 }, () => {
  assert.deepEqual(B3_MEASUREMENTS, {
    "view-drag": {
      "0": ["verdict", "peakBeforeDragKb", "peakAfterDragKb", "dragCpuSeconds"],
      "frame-records": ["dragFrameP90Ms", "dragStepP90Ms", "dragFirstFrameMs"],
    },
    "resize-catch-up": {
      captured: ["verdict"],
      "frame-records": ["maximiseFrameP90Ms", "maximiseStepP90Ms"],
    },
    "split-load": ["hostGrowthKb"],
    "idle-tab": ["idleTabCostKb", "documentPartKb"],
    "section-view": ["verdict"],
    "input-latency": ["fieldMedianMs", "fieldP90Ms", "documentMedianMs", "documentP90Ms"],
  });
});

test("every B3 key of a benchmark is the verdict or a flat camelCase name that ends in its unit", { timeout: 5000 }, () => {
  const keys = Object.values(B3_MEASUREMENTS).flatMap((entry) => (Array.isArray(entry) ? entry : Object.values(entry).flat()));
  for (const key of keys) {
    assert.ok(key === "verdict" || /^[a-z][a-zA-Z0-9]*(Kb|Ms|Seconds|PerSecond)$/.test(key), `${key} is not the verdict and does not end in its unit`);
  }
  assert.ok(Object.isFrozen(B3_MEASUREMENTS) && Object.isFrozen(B3_MEASUREMENTS["view-drag"]) && Object.isFrozen(B3_MEASUREMENTS["view-drag"]["0"]));
});

test("B3_SETTINGS names the settings of each state of each benchmark, a trace state by traceSettings and the others by their classes", { timeout: 5000 }, () => {
  const view = { "diagnostics.performance": true, "diagnostics.log": { call: "debug", frame: "trace" } };
  assert.deepEqual(B3_SETTINGS, {
    "view-drag": { "0": traceSettings(0), "frame-records": traceSettings(FRAME_RECORDS) },
    "resize-catch-up": {
      captured: { "diagnostics.performance": true, "diagnostics.log": { lifecycle: "debug", call: "debug", frame: "debug" } },
      "frame-records": traceSettings(FRAME_RECORDS),
    },
    "split-load": { "diagnostics.performance": false, "diagnostics.log": { call: "debug" } },
    "idle-tab": { "diagnostics.performance": true, "diagnostics.log": { call: "debug" } },
    "section-view": view,
    "input-latency": traceSettings(0),
  });
});

test("B3_SETTINGS has the benchmarks and the states of B3_MEASUREMENTS; a state named after a trace state holds its traceSettings and another state differs from each", { timeout: 5000 }, () => {
  assert.deepEqual(Object.keys(B3_SETTINGS), Object.keys(B3_MEASUREMENTS));
  const traceStates = [0, 1, FRAME_RECORDS];
  for (const [name, declared] of Object.entries(B3_MEASUREMENTS)) {
    const settings = B3_SETTINGS[name];
    if (Array.isArray(declared)) {
      assert.ok(Object.isFrozen(settings) && Object.isFrozen(settings["diagnostics.log"]), `${name} is not frozen`);
      continue;
    }
    assert.ok(Object.isFrozen(settings), `${name} is not frozen`);
    assert.deepEqual(Object.keys(settings), Object.keys(declared), `${name} has other states than its keys`);
    for (const [state, value] of Object.entries(settings)) {
      assert.ok(Object.isFrozen(value) && Object.isFrozen(value["diagnostics.log"]), `${name} ${state} is not frozen`);
      const trace = traceStates.find((candidate) => String(candidate) === state);
      if (trace !== undefined) {
        assert.deepEqual(value, traceSettings(trace), `${name} ${state} differs from traceSettings(${JSON.stringify(trace)})`);
        continue;
      }
      for (const other of traceStates) {
        assert.notDeepEqual(value, traceSettings(other), `${name} ${state} holds the settings of the trace state ${JSON.stringify(other)}`);
      }
    }
  }
});
