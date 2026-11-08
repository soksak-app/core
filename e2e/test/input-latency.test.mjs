import assert from "node:assert/strict";
import test from "node:test";

import { B3_MEASUREMENTS } from "../benchmark/measurements.mjs";
import { CONFIGURATIONS, INPUT_LATENCY_TARGETS, clockOffset, inputLatencyB3Values, keyFigures, keyLatency } from "../input-latency.mjs";

test("the input latency check measures the view field and the document region of the input probe in four configurations", { timeout: 5000 }, () => {
  assert.deepEqual(INPUT_LATENCY_TARGETS, ["field", "document"]);
  assert.deepEqual(CONFIGURATIONS.map(({ trace, gate }) => ({ trace, gate: gate === undefined ? "default" : "info" })),
    [{ trace: false, gate: "default" }, { trace: true, gate: "default" }, { trace: false, gate: "default" }, { trace: false, gate: "info" }]);
});

test("the figures of a configuration keep the time of each key in the order of the keys", { timeout: 5000 }, () => {
  assert.deepEqual(keyFigures([12.04, 9.96, 30.01, 11, 10]), {
    median_ms: 11, p90_ms: 30, max_ms: 30, keys_ms: [12, 10, 30, 11, 10],
  });
});

test("the clock offset of the probe document comes from the sample with the shortest round trip", { timeout: 5000 }, () => {
  const clock = (sourceNowMs) => ({ documentTimeOriginMs: 1000, sourceNowMs, sourceResolutionMs: 1 });
  const offset = clockOffset([
    { sentMs: 5000, receivedMs: 5010, clock: clock(4500) },
    { sentMs: 5020, receivedMs: 5022, clock: clock(4521) },
  ]);
  assert.deepEqual(offset, { offsetMs: 500, errorMs: 2 });
  assert.throws(() => clockOffset([]), new Error("the clock of the probe document has no sample"));
});

test("the latency of a key runs from the injection to its arrival mapped to the clock of the check", { timeout: 5000 }, () => {
  // The document clock is 500 ms ahead: a key sent at 6000 that arrives at 1000 + 5506 on the document clock took 6 ms.
  assert.equal(keyLatency({ startedMs: 6000, atMs: 5506, documentTimeOriginMs: 1000, offsetMs: 500 }), 6);
});

test("the B3 values of a target are the median and the 90th percentile of the keys of the configurations with the trace off and the default gate",
  { timeout: 5000 }, () => {
    const results = [
      { trace: false, gate: "default", keys_ms: [10, 11, 12] },
      { trace: true, gate: "default", keys_ms: [100, 100, 100] },
      { trace: false, gate: "default", keys_ms: [13, 14, 40] },
      { trace: false, gate: "info", keys_ms: [200, 200, 200] },
    ];
    assert.deepEqual(inputLatencyB3Values("document", results), { documentMedianMs: 13, documentP90Ms: 40 });
    assert.deepEqual(inputLatencyB3Values("field", results), { fieldMedianMs: 13, fieldP90Ms: 40 });
    assert.deepEqual([...Object.keys(inputLatencyB3Values("field", results)), ...Object.keys(inputLatencyB3Values("document", results))],
      B3_MEASUREMENTS["input-latency"]);
    assert.throws(() => inputLatencyB3Values("document", results.slice(1, 2)),
      new Error("the input latency of document has no key of a configuration with the trace off and the default gate"));
  });
