// The input latency check (e2e/input-latency.test.mjs): the plugins of its tabs, its configurations and the figures that it prints
// and writes for B3. The `term` and the `terminal` plugin declare the same statuses and commands under their
// own id (`<plugin>.session`, `<plugin>.screen`, `<plugin>.screen.read`), so one check measures both.
/** The plugins of the measured tabs. */
export const INPUT_LATENCY_PLUGINS = ["terminal", "term"];

/** The producer gate of every class at `info` (docs/spec/logging.md#limits, docs/spec/logging.md#policy). */
const INFO = { lifecycle: "info", input: "info", call: "info", io: "info", frame: "info" };

/** The configurations of a tab, in order: the trace off, on and off again under the default gate, and the gate of every class at info. */
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
 * The B3 values of the tab of `plugin` (G7): the median and the 90th percentile of the keys of the configurations with the trace off and
 * the default gate, `<plugin>MedianMs` and `<plugin>P90Ms`. results are the figures of the configurations with `trace` and `gate`.
 */
export function inputLatencyB3Values(plugin, results) {
  const keys = results.filter(({ trace, gate }) => trace === false && gate === "default").flatMap(({ keys_ms: times }) => times);
  if (keys.length === 0) throw new Error(`the input latency of ${plugin} has no key of a configuration with the trace off and the default gate`);
  const sorted = keys.toSorted((a, b) => a - b);
  return { [`${plugin}MedianMs`]: percentile(sorted, 0.5), [`${plugin}P90Ms`]: percentile(sorted, 0.9) };
}
