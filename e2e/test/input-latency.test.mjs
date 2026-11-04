import assert from "node:assert/strict";
import test from "node:test";

import { B3_MEASUREMENTS } from "../benchmark/measurements.mjs";
import { CONFIGURATIONS, INPUT_LATENCY_PLUGINS, inputLatencyB3Values, keyFigures } from "../input-latency.mjs";

test("the input latency check measures a terminal tab and a term tab in four configurations", { timeout: 5000 }, () => {
  assert.deepEqual(INPUT_LATENCY_PLUGINS, ["terminal", "term"]);
  assert.deepEqual(CONFIGURATIONS.map(({ trace, gate }) => ({ trace, gate: gate === undefined ? "default" : "info" })),
    [{ trace: false, gate: "default" }, { trace: true, gate: "default" }, { trace: false, gate: "default" }, { trace: false, gate: "info" }]);
});

test("the figures of a configuration keep the time of each key in the order of the keys", { timeout: 5000 }, () => {
  assert.deepEqual(keyFigures([12.04, 9.96, 30.01, 11, 10]), {
    median_ms: 11, p90_ms: 30, max_ms: 30, keys_ms: [12, 10, 30, 11, 10],
  });
});

test("the B3 values of a tab are the median and the 90th percentile of the keys of the configurations with the trace off and the default gate",
  { timeout: 5000 }, () => {
    const results = [
      { trace: false, gate: "default", keys_ms: [10, 11, 12] },
      { trace: true, gate: "default", keys_ms: [100, 100, 100] },
      { trace: false, gate: "default", keys_ms: [13, 14, 40] },
      { trace: false, gate: "info", keys_ms: [200, 200, 200] },
    ];
    assert.deepEqual(inputLatencyB3Values("term", results), { termMedianMs: 13, termP90Ms: 40 });
    assert.deepEqual(inputLatencyB3Values("terminal", results), { terminalMedianMs: 13, terminalP90Ms: 40 });
    assert.deepEqual([...Object.keys(inputLatencyB3Values("terminal", results)), ...Object.keys(inputLatencyB3Values("term", results))],
      B3_MEASUREMENTS["input-latency"]);
    assert.throws(() => inputLatencyB3Values("term", results.slice(1, 2)),
      new Error("the input latency of term has no key of a configuration with the trace off and the default gate"));
  });
