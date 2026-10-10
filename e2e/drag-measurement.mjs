import assert from "node:assert/strict";

// Confirms the number of round trips and the return to the start point from real capture coordinates. A frozen screen cannot pass.
//
// The page displays only the newest of the layouts that are waiting (docs/spec/native-surfaces.md), so a position held for less than one display
// can be replaced. The drag stays only one step at the start position between round trips, so that position may not
// be visible. The recording is at the start-side end at the beginning and at the end, and must reach the far end once per round trip.
export function assertRoundTrips(positions, times) {
  assert.ok(positions.length > 1 && positions.every(Number.isFinite), "drag positions are missing or invalid");
  const low = Math.min(...positions), high = Math.max(...positions);
  const span = high - low;
  assert.ok(span >= 50, `the card moved only ${span}pt; the requested drag was not recorded`);
  const end = (position) => position <= low + span * .2 ? "low" : position >= high - span * .2 ? "high" : null;
  const start = end(positions[0]);
  assert.ok(start && end(positions.at(-1)) === start,
    `the recording must start and end at the start end; positions: ${positions.join(",")}`);
  const far = start === "low" ? "high" : "low";
  let visits = 0;
  let inside = false;
  for (const position of positions) {
    const now = end(position) === far;
    if (now && !inside) visits++;
    inside = now;
  }
  assert.equal(visits, times,
    `expected the far end once in each of ${times} round trips, observed ${visits}; positions: ${positions.join(",")}`);
  assert.ok(Math.abs(positions[0] - positions.at(-1)) <= 1,
    `the recorded card must return to its initial position: ${positions[0]} → ${positions.at(-1)}`);
  return span;
}

/**
 * Measures, for each recorded frame, how late (ms) the card position was behind the pointer.
 *
 * samples is a list of { time, position } (points) whose first item is the position before the drag. ticks are
 * the times at which the host sent the steps, on the same clock as the frames. boundary is the boundary position
 * that the page reported, whose first value is before the drag and whose (k+1)th value is after step k. The boundary sticks to a neighboring line or
 * stops at the minimum size, so this value, not the pointer offset, matches the layout of a frame to a step.
 * The lag is the time from the last time the grid left the layout that the frame showed to the display time
 * of that frame. If the grid is still in that layout, the lag is 0. A position that matches no step
 * cannot be measured and fails.
 */
export function pointerLag(samples, ticks, boundary) {
  assert.ok(Array.isArray(ticks) && ticks.length > 0, "the host reported no step times");
  assert.equal(boundary?.length, ticks.length + 1,
    `the page reported ${boundary?.length} boundary positions for ${ticks.length} steps`);
  const moved = (k) => boundary[k + 1] - boundary[0];
  const base = samples[0].position;
  let worst = { lag: 0, time: null, shown: null, step: null, sent: null };
  const lags = [];
  for (const { time, position } of samples) {
    if (time < ticks[0]) continue;
    const shown = position - base;
    let k = ticks.length - 1;
    while (k >= 0 && ticks[k] > time) k--;
    const sent = k;
    while (k >= 0 && Math.abs(moved(k) - shown) > 1) k--;
    if (k < 0 && Math.abs(shown) > 1) {
      assert.fail(`the card offset ${shown.toFixed(1)}pt at ${time.toFixed(1)}ms matches no step sent before it ` +
        `(last step ${sent}, boundary offset ${moved(sent).toFixed(1)}pt)`);
    }
    // k is the last step that has this layout, so the grid left this layout at step k+1.
    const lag = k < sent ? time - ticks[k + 1] : 0;
    lags.push(lag);
    if (lag > worst.lag) worst = { lag, time, shown, step: k, sent };
  }
  lags.sort((a, b) => a - b);
  // default: when no frame is measured, there is no lag (0).
  const at = (fraction) => lags[Math.min(lags.length - 1, Math.floor(lags.length * fraction))] ?? 0;
  return { ...worst, median: at(0.5), p90: at(0.9) };
}

/**
 * Divides the lag of the latest frame into the stages of the layout transaction.
 *
 * lag is the result of pointerLag and layouts is the list of { ticket, begun, presented, committed } recorded by the host (ms, on the same clock as the frames).
 * For each transaction that was open between the time of the step at which the grid left that layout and the display time of that frame,
 * it records the time from the leaving time to each stage. The page starts the next preparation after it receives the answer of the earlier transaction
 * (docs/spec/native-surfaces.md), so a transaction that was already open at that time is included.
 */
export function lagStages(lag, ticks, layouts) {
  if (!lag.time || !Array.isArray(layouts)) return "no layout trace";
  const left = ticks[lag.step + 1];
  const at = (value) => (value === null ? "-" : `+${(value - left).toFixed(1)}`);
  // It also records the first transaction that started after the frame. It shows the time in which the page did not start a preparation.
  const next = layouts.find(({ begun }) => begun !== null && begun > lag.time);
  // A replaced transaction has no commit time, so the check looks whether it ended by the time of the last stage.
  const open = layouts.filter(({ begun, presented, committed }) =>
    begun !== null && begun <= lag.time && (committed ?? presented ?? Infinity) >= left).concat(next ? [next] : []);
  const stages = open.map(({ ticket, begun, presented, committed }) =>
    `#${ticket} begun ${at(begun)} presented ${at(presented)} committed ${at(committed)}`);
  return `step ${lag.step + 1} at ${left.toFixed(1)}ms, frame at +${(lag.time - left).toFixed(1)}: ${stages.join("; ") || "no transaction"}`;
}

/** The minimum duration (ms) of a state that must appear in the recording. It is two frames of a 60Hz screen. */
const HOLD = 34;

/**
 * Confirms that a layout held longer than one display appeared in the recording.
 *
 * The page displays only the newest of the layouts that are waiting (docs/spec/native-surfaces.md), so a position held briefly can be
 * replaced. From boundary and ticks it computes the time the boundary stayed at each step, and a position held for HOLD or longer (including the positions before the drag and after the end)
 * must appear in the recorded frames after it was entered. samples are { time, position } and the first item is
 * the position before the drag.
 */
export function assertHeldStatesShown(samples, ticks, boundary, hold = HOLD) {
  assert.ok(Array.isArray(ticks) && ticks.length > 0, "the host reported no step times");
  assert.equal(boundary?.length, ticks.length + 1,
    `the page reported ${boundary?.length} boundary positions for ${ticks.length} steps`);
  const base = samples[0].position;
  const values = boundary.map((value) => value - boundary[0]);
  // State i is values[i], and it is held from step i (ticks[i-1]) to the next step.
  const segments = [];
  for (let i = 0; i < values.length; i++) {
    const start = i === 0 ? -Infinity : ticks[i - 1];
    const end = i < ticks.length ? ticks[i] : Infinity;
    const last = segments.at(-1);
    if (last && Math.abs(last.value - values[i]) <= 1) last.end = end;
    else segments.push({ value: values[i], start, end });
  }
  const missing = segments.filter((segment) => segment.end - segment.start >= hold).filter((segment) =>
    !samples.some(({ time, position }) => time >= segment.start && Math.abs(position - base - segment.value) <= 1));
  assert.deepEqual(missing.map(({ value, start, end }) => ({ value, held: end - start })), [],
    `layouts held for ${hold}ms or longer are missing from the recording; ` +
    `recorded offsets: ${samples.map(({ position }) => (position - base).toFixed(0)).join(",")}`);
}

/**
 * Measures the cycle of the layout transactions that the host recorded during the drag. layouts is a list of { begun, requested, presented } (ms). It returns the median and the 90th percentile of
 * the interval between the starts of two consecutive transactions (interval), the time from the start of a transaction to its display (presenting), the time from the start to the display confirmation request (drawing), and
 * the time from the request to the display (waiting) (docs/features.md F92). Stages that did not happen are not included.
 */
export function transactionCadence(layouts) {
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
  };
}
