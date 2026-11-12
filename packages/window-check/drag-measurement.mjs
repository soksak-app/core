import assert from "node:assert/strict";
import { lostStills, toldStill } from "./stills.mjs";

/** Measures every view-drag frame interval, including frames whose geometry cannot be measured. */
export function measureDragFrameCadence(times) {
  assert.ok(Array.isArray(times) && times.length >= 2 && times.every((time, index) =>
    Number.isFinite(time) && (index === 0 || time > times[index - 1])),
  "view drag frame times are missing, non-finite or not strictly increasing");
  let longest = 0;
  for (let index = 1; index < times.length; index++) longest = Math.max(longest, times[index] - times[index - 1]);
  return longest;
}

/**
 * The period of the display refresh in effect at a time: the latest observed refresh at or before it.
 * refreshes is { times, periods } from display-refresh.mjs, in milliseconds.
 */
function periodAt(refreshes, time) {
  assert.ok(Array.isArray(refreshes?.times) && refreshes.times.length > 0 &&
    refreshes.periods?.length === refreshes.times.length, "display refreshes are missing");
  const index = refreshes.times.findLastIndex((refresh) => refresh <= time);
  assert.ok(index >= 0, `no display refresh at or before ${time}ms`);
  const period = refreshes.periods[index];
  assert.ok(Number.isFinite(period) && period > 0, "drag display period is invalid");
  return period;
}

function gapsExceed(times, refreshes) {
  return times.some((time, index) => index > 0 && time - times[index - 1] > 2 * periodAt(refreshes, time));
}

/**
 * The stills (toldStill) that the recording lost between the first and the last of the shown frames `times` (request times,
 * ms), read from the still rows `stills` (readStills). A still lost at a gap of one refresh leaves an interval of two refreshes,
 * which the bound of two periods passes, so a cadence reads the rows of its span and not only the intervals.
 */
function lostInSpan(times, stills) {
  assert.ok(Array.isArray(stills), "the still rows of the recording are missing, so its cadence cannot be judged");
  return lostStills(stills, times[0], times.at(-1)).map(toldStill);
}

/**
 * Applies the view-drag cadence target: no still lost between the first and the last shown frame (`times`, the request times of
 * the shown stills), and no interval longer than two periods of the display at the interval's end.
 */
export function assertDragFrameCadence(times, refreshes, stills) {
  const longest = measureDragFrameCadence(times);
  const lost = lostInSpan(times, stills);
  assert.ok(lost.length === 0, `view drag recording lost ${lost.length} stills between ${times[0].toFixed(1)}ms and ` +
    `${times.at(-1).toFixed(1)}ms: ${lost.join(", ")}`);
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    const target = 2 * periodAt(refreshes, times[index]);
    assert.ok(gap <= target, `view drag recording gap ${gap.toFixed(3)}ms exceeds ${target.toFixed(3)}ms`);
  }
  return longest;
}

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
 * samples is a list of { time, completed, position } (points) whose first item is the position before the drag: a still of
 * the recording and the position that it shows. A still shows the window at one moment between its request (time) and its
 * completion (completed), so the layout that it shows was left no later than its completion. ticks are
 * the times at which the host sent the steps, on the same clock as the frames. boundary is the boundary position
 * that the page reported, whose first value is before the drag and whose (k+1)th value is after step k. The boundary sticks to a neighboring line or
 * stops at the minimum size, so this value, not the pointer offset, matches the layout of a frame to a step.
 * The lag is the time from the last time the grid left the layout that the still showed to the completion of that still. If
 * the grid is still in that layout, the lag is 0. A position that matches no step
 * cannot be measured and fails.
 */
export function pointerLag(samples, ticks, boundary) {
  assert.ok(Array.isArray(samples) && samples.length > 0 && samples.every((sample) =>
    sample && Number.isFinite(sample.completed) && Number.isFinite(sample.position)),
  "drag samples are missing or contain a non-finite completion time or position");
  assert.ok(Array.isArray(ticks) && ticks.length > 0, "the host reported no step times");
  assert.equal(boundary?.length, ticks.length + 1,
    `the page reported ${boundary?.length} boundary positions for ${ticks.length} steps`);
  const moved = (k) => boundary[k + 1] - boundary[0];
  const base = samples[0].position;
  let worst = { lag: 0, time: null, shown: null, step: null, sent: null };
  const lags = [];
  for (const { completed: time, position } of samples) {
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
    lags.push({ lag, time });
    if (lag > worst.lag) worst = { lag, time, shown, step: k, sent };
  }
  lags.sort((a, b) => a.lag - b.lag);
  assert.ok(lags.length > 0, "drag measurement has no captured frame at or after the first input");
  const at = (fraction) => lags[Math.min(lags.length - 1, Math.floor(lags.length * fraction))];
  const median = at(0.5);
  const p90 = at(0.9);
  return { ...worst, median: median.lag, medianTime: median.time, p90: p90.lag, p90Time: p90.time };
}

/**
 * Divides the lag of the latest frame into the stages of the layout transaction.
 *
 * lag is the result of pointerLag and layouts is the list of { ticket, begun, presented, committed } recorded by the host (ms, on the same clock as the frames).
 * For each transaction that was open between the time of the step at which the grid left that layout and the completion of that still,
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
 * must appear in a still requested after it was entered. samples are { time, position }, the request time of a still and the
 * position that it shows, and the first item is the position before the drag. When a layout is missing, the failure names the
 * stills that the recording lost in the time of the missing layouts (stills, the still rows of readStills): a layout held in a
 * still that the recording lost is missing all the same.
 */
export function assertHeldStatesShown(samples, ticks, boundary, stills, hold = HOLD) {
  assert.ok(Array.isArray(stills), "the still rows of the recording are missing, so a missing layout cannot be told");
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
  // The step times and the frame times are on the clock of the layout trace, so the message can be laid over the transactions.
  const ms = (value) => value.toFixed(1);
  const lost = missing.length === 0 ? [] : lostStills(stills, Math.min(...missing.map(({ start }) => start)),
    Math.max(...missing.map(({ end }) => end))).map(toldStill);
  assert.deepEqual(missing.map(({ value, start, end }) => ({ value, held: end - start })), [],
    `layouts held for ${hold}ms or longer are missing from the recording: ` +
    `${missing.map(({ value, start, end }) => `${value.toFixed(0)} held ${ms(start)}..${ms(end)}`).join(", ")}; ` +
    (lost.length === 0 ? "the recording lost no still in that time; "
      : `the recording lost ${lost.length} stills in that time: ${lost.join(", ")}; `) +
    `steps at ${ticks.map(ms).join(",")}; boundary ${boundary.map((value) => String(Math.round(value * 10) / 10)).join(",")}; ` +
    `recorded ${samples.map(({ time, position }) => `${ms(time)}:${(position - base).toFixed(0)}`).join(",")}`);
}

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


/**
 * Requires final raster edges within 2 pt by the second still requested after the last drag input. samples are the stills with
 * their request time (time).
 */
export function assertFinalContentSize(samples, ended) {
  assert.ok(Number.isFinite(ended), "final content input time is invalid");
  assert.ok(Array.isArray(samples) && samples.every((sample, index) =>
    sample && Number.isFinite(sample.time) && (index === 0 || sample.time > samples[index - 1].time)),
  "final content frame times are missing or invalid");
  const after = samples.filter((sample) => sample.time > ended);
  assert.ok(after.length >= 2, "final content requires two measured post-input frames");
  for (const [index, sample] of after.entries()) {
    assert.ok(Number.isFinite(sample.left) && Number.isFinite(sample.right),
      `final content geometry is missing at post-input frame ${index + 1}`);
    if (index > 0) assert.ok(Math.abs(sample.left) <= 2 && Math.abs(sample.right) <= 2,
      `final content edges differ at post-input frame ${index + 1}: left ${sample.left}pt, right ${sample.right}pt`);
  }
  return { frames: after.length,
    settledFrame: Math.abs(after[0].left) <= 2 && Math.abs(after[0].right) <= 2 ? 1 : 2 };
}


/**
 * The times of the shown frames of the drag, which measureDragPerformance judges: from the first input to the first shown frame
 * after the last step. samples are the stills whose pixels differ from the still before them, with the request time of each: a
 * recording takes a still at each gap whether the window changed or not, and a repeated still neither shows a layout nor ends a
 * gap between two layouts. After the display of the last step the window has nothing to show, so the time until the recording
 * stops is no gap of the drag.
 */
export function shownTimes(samples, ticks) {
  assert.ok(Array.isArray(ticks) && ticks.length > 0, "the host reported no step times");
  const times = samples.map(({ time }) => time).filter((time) => time >= ticks[0]);
  const last = times.findIndex((time) => time > ticks.at(-1));
  return last < 0 ? times : times.slice(0, last + 1);
}

/**
 * Records the cadence and latency targets. Each gap and each latency value is judged against the display period
 * at its own time, so a window that moved between displays keeps each judgment on the display it was shown on. `times` are the
 * request times of the shown stills, and `stills` the still rows of the recording (readStills): a still lost between the first
 * and the last shown still misses the target `stills` and is named in `lost`.
 */
export function measureDragPerformance(times, lag, refreshes, stills) {
  const longest = measureDragFrameCadence(times);
  const lost = lostInSpan(times, stills);
  const latency = { median: lag?.median, p90: lag?.p90, worst: lag?.lag };
  assert.ok(Object.values(latency).every((value) => Number.isFinite(value) && value >= 0),
    "drag latency measurements are missing or invalid");
  // A zero latency has no time and meets every target.
  const latencyTime = { median: lag?.medianTime, p90: lag?.p90Time, worst: lag?.time };
  assert.ok(Object.keys(latency).every((key) => latency[key] === 0 || Number.isFinite(latencyTime[key])),
    "drag latency times are missing or invalid");
  const factors = { median: 2.5, p90: 3, worst: 4 };
  const exceeded = [...(lost.length > 0 ? ["stills"] : []), ...(gapsExceed(times, refreshes) ? ["cadence"] : [])];
  for (const key of Object.keys(factors)) {
    if (latency[key] > 0 && latency[key] > factors[key] * periodAt(refreshes, latencyTime[key])) exceeded.push(key);
  }
  // The interval of the shown frames follows the interval of the input while a layout takes less than that interval.
  const intervals = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
  const frameInterval = intervals[Math.floor(intervals.length / 2)];
  return { cadence: { measured: longest }, frameInterval, latency, lost, exceeded, targetsMet: exceeded.length === 0 };
}

/** Applies the unchanged targets in a dedicated performance benchmark. */
export function assertDragPerformance(times, lag, refreshes, stills) {
  const report = measureDragPerformance(times, lag, refreshes, stills);
  assert.ok(report.targetsMet, `drag performance targets exceeded: ${JSON.stringify(report)}`);
  return report;
}
