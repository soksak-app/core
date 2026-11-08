// The input latency check (e2e/input-latency.test.mjs): the targets of its keys, its configurations, the clock that maps the
// arrival of a key in the document of the input probe to the clock of the check, and the figures that it prints and writes for B3.
// The input probe (e2e/fixtures/input-probe/probe) records each key that reaches the text field of its view and of its native
// document region with the time of its event (`atMs` of `probeinput.field` and `probeinput.document`), and `probeinput.clock` maps
// that time to the clock of the source.

/** The targets of the measured keys: the text field of the view of the input probe and the field of its native document region. */
export const INPUT_LATENCY_TARGETS = ["field", "document"];

/** The producer gate of every class at `info` (docs/spec/logging.md#limits, docs/spec/logging.md#policy). */
const INFO = { lifecycle: "info", input: "info", call: "info", io: "info", frame: "info" };

/** The configurations of a target, in order: the trace off, on and off again under the default gate, and the gate of every class at info. */
export const CONFIGURATIONS = Object.freeze([{ trace: false }, { trace: true }, { trace: false }, { trace: false, gate: INFO }]);

/** The value at the rank `share` of the sorted values. */
const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
const tenth = (value) => Number(value.toFixed(1));

/** The figures of the keys of one configuration in ms: median, 90th percentile, maximum and the time of each key in key order. */
export function keyFigures(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median_ms: tenth(percentile(sorted, 0.5)), p90_ms: tenth(percentile(sorted, 0.9)), max_ms: tenth(sorted.at(-1)),
    keys_ms: samples.map(tenth) };
}

/**
 * The offset from the clock of the check to the clock of a probe document, in ms, from `samples` of `probeinput.clock`: each sample
 * is `{sentMs, receivedMs, clock}`, where sentMs and receivedMs are the epoch times of the check around the request and clock its
 * result. The document read its clock between the two, so the sample with the shortest round trip bounds the offset best; the
 * offset is that of its midpoint, and `errorMs` is half its round trip plus the resolution of the source clock.
 */
export function clockOffset(samples) {
  if (samples.length === 0) throw new Error("the clock of the probe document has no sample");
  const best = samples.reduce((a, b) => (b.receivedMs - b.sentMs < a.receivedMs - a.sentMs ? b : a));
  const midpoint = (best.sentMs + best.receivedMs) / 2;
  const source = best.clock.documentTimeOriginMs + best.clock.sourceNowMs;
  return { offsetMs: source - midpoint, errorMs: (best.receivedMs - best.sentMs) / 2 + best.clock.sourceResolutionMs };
}

/**
 * The latency of a key in ms: from `startedMs`, the epoch time of the check just before it injected the key, to the arrival of the key
 * in the probe document, `atMs` after `documentTimeOriginMs` on the clock of the document, which `offsetMs` (clockOffset) maps to the
 * clock of the check.
 */
export function keyLatency({ startedMs, atMs, documentTimeOriginMs, offsetMs }) {
  return documentTimeOriginMs + atMs - offsetMs - startedMs;
}

/**
 * The B3 values of `target` (G7): the median and the 90th percentile of the keys of the configurations with the trace off and the
 * default gate, `<target>MedianMs` and `<target>P90Ms`. results are the figures of the configurations with `trace` and `gate`.
 */
export function inputLatencyB3Values(target, results) {
  const keys = results.filter(({ trace, gate }) => trace === false && gate === "default").flatMap(({ keys_ms: times }) => times);
  if (keys.length === 0) throw new Error(`the input latency of ${target} has no key of a configuration with the trace off and the default gate`);
  const sorted = keys.toSorted((a, b) => a - b);
  return { [`${target}MedianMs`]: percentile(sorted, 0.5), [`${target}P90Ms`]: percentile(sorted, 0.9) };
}
