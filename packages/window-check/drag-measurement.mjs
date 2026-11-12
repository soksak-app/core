import assert from "node:assert/strict";

/**
 * Measures the cycle of the layout transactions that the host recorded during the drag. layouts is a list of { begun, requested, presented } (ms). It returns the median and the 90th percentile of
 * the interval between the starts of two consecutive transactions (interval), the time from the start of a transaction to its display (presenting), the time from the start to the display confirmation request (drawing), and
 * the time from the request to the display (waiting) (docs/features.md F92). Stages that did not happen are not included.
 */
export function transactionCadence(layouts) {
  assert.ok(Array.isArray(layouts), "layout transactions must be an array");
  for (const [index, layout] of layouts.entries()) {
    assert.ok(layout && typeof layout === "object" && !Array.isArray(layout),
      `layout transaction ${index} must be an object`);
    let previous = null;
    for (const stage of ["begun", "requested", "presented", "committed"]) {
      const value = layout[stage];
      assert.ok(value === null || Number.isFinite(value),
        `layout transaction ${index} ${stage} must be finite or null`);
      if (value === null) continue;
      assert.ok(previous === null || value >= previous,
        `layout transaction ${index} ${stage} occurs before its prior stage`);
      previous = value;
    }
  }
  const begun = layouts.map((layout) => layout.begun).filter((value) => value !== null).sort((a, b) => a - b);
  const intervals = begun.slice(1).map((value, index) => value - begun[index]);
  const between = (from, to) => layouts.filter((layout) => layout[from] !== null && layout[to] !== null)
    .map((layout) => layout[to] - layout[from]);
  const spread = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    // default: with no values there is nothing to measure (null).
    const at = (fraction) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : null;
    return { count: sorted.length, median: at(0.5), p90: at(0.9) };
  };
  return {
    interval: spread(intervals),
    presenting: spread(between("begun", "presented")),
    drawing: spread(between("begun", "requested")),
    waiting: spread(between("requested", "presented")),
    committing: spread(between("presented", "committed")),
    total: spread(between("begun", "committed")),
  };
}

