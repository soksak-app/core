// Judgments of the timing of layouts and of the content frames of views, from the numbers that the host and the views report: the
// layout transactions of the layout trace ({ticket, begun, requested, presented, committed, commitPath, openAtCommit, flushed,
// displayed, viewport}, ms on the host monotonic clock), the times of the steps of a drag, the window resize events and the content
// frames that a view traces (viewContentFrameEvents of view-metrics-collection.mjs). No judgment reads a recorded frame. Each judgment
// returns its measured values with `failures`, the requirements that the values miss, which is empty when they meet them.
import assert from "node:assert/strict";

/** The time (ms) of one refresh of a display of `refreshRate` Hz (host.window.refreshRate). */
export function displayPeriod(refreshRate) {
  assert.ok(Number.isFinite(refreshRate) && refreshRate > 0, `the refresh rate ${refreshRate} of the display is not a positive number`);
  return 1000 / refreshRate;
}

/**
 * The time (ms) at which the layout transaction `layout` was sent to the render server: its commit, or the flush of the outer
 * transaction that held its commit when that came later. A transaction that did not commit or was cancelled sent nothing (null).
 */
export function sentAt(layout) {
  if (layout.committed === null || layout.commitPath === "cancel") return null;
  return layout.flushed === null ? layout.committed : Math.max(layout.committed, layout.flushed);
}

/** The value at `fraction` (0 to 1) of the sorted `values`, as transactionCadence of drag-measurement.mjs reads it. */
const at = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

/** The layouts of `layouts` that began from `from` to `to` (ms). */
const begunIn = (layouts, from, to) => layouts.filter((layout) => layout.begun !== null && layout.begun >= from && layout.begun <= to);

/**
 * The round trips of the drag `run` ({ticks, tripSteps}) as {from, to} (ms), from the first to the last step of each: a native drag
 * answers `tripSteps`, the number of steps of each round trip, and waits between a release and the next press until the window has
 * presented, so the pointer moves nothing there; a drag of the page runs its round trips without a pause, so it is one.
 */
export function dragTrips({ ticks, tripSteps }) {
  assert.ok(Array.isArray(ticks) && ticks.length > 0, `the drag has no step times: ${JSON.stringify(ticks)}`);
  if (tripSteps === undefined) return [{ from: ticks[0], to: ticks.at(-1) }];
  const total = tripSteps.reduce((sum, count) => sum + count, 0);
  assert.ok(tripSteps.every((count) => Number.isInteger(count) && count > 0) && total === ticks.length,
    `the steps of the round trips ${JSON.stringify(tripSteps)} are not the ${ticks.length} step times of the drag`);
  let first = 0;
  return tripSteps.map((count) => {
    const trip = { from: ticks[first], to: ticks[first + count - 1] };
    first += count;
    return trip;
  });
}

/**
 * The commits of a view drag follow one another within two display refreshes: the number of refreshes between the display
 * refreshes that carried consecutive commits (`displayed`) of the layouts that began from the first step to the last step of each
 * round trip of `trips` ({from, to}, ms; the whole drag from `from` to `to` when absent), which is the interval between those
 * refreshes in display periods (`period`, ms), rounded to the refresh. Two commits on one refresh are 0 refreshes apart. Between
 * two round trips the pointer is up, so no interval spans them. Fewer than two such commits in a round trip, and a commit with no
 * display refresh, are failures.
 */
export function commitCadence(layouts, { from, to, period, trips = [{ from, to }] }) {
  const limit = 2;
  const failures = [];
  const displayed = [];
  const refreshes = [];
  let count = 0;
  for (const trip of trips) {
    const committed = begunIn(layouts, trip.from, trip.to).filter((layout) => sentAt(layout) !== null);
    count += committed.length;
    failures.push(...committed.filter((layout) => layout.displayed === null)
      .map((layout) => `the commit of ticket ${layout.ticket} has no display refresh`));
    const times = committed.map((layout) => layout.displayed).filter((time) => time !== null).sort((a, b) => a - b);
    if (committed.length < 2) failures.push(`the drag committed ${committed.length} layouts from ${trip.from} to ${trip.to} ms, fewer than 2`);
    times.slice(1).forEach((time, index) => {
      const between = Math.round((time - times[index]) / period);
      refreshes.push(between);
      if (between > limit) {
        failures.push(`the commit displayed at ${time} ms followed the commit before it after ${between} display refreshes, ` +
          `more than ${limit}`);
      }
    });
    displayed.push(...times);
  }
  return { count, displayed, refreshes, limit, failures };
}

/**
 * Each layout of a divider drag commits within four display periods (`period`, ms) after the grid began it, and over the drag the
 * median delay is at most 2.5 and the 90th percentile at most 3 display periods. The layouts are those that began from the first
 * step `from` to the last step `to`; a cancelled layout was replaced by a later one, and a layout that did not commit is a failure.
 */
export function stepCommitDelays(layouts, { from, to, period }) {
  const begun = begunIn(layouts, from, to);
  const failures = [];
  if (begun.length === 0) failures.push(`no layout began from ${from} to ${to} ms`);
  const delays = [];
  for (const layout of begun) {
    if (layout.commitPath === "cancel") continue;
    const sent = sentAt(layout);
    if (sent === null) {
      failures.push(`the layout of ticket ${layout.ticket} began at ${layout.begun} ms and did not commit`);
      continue;
    }
    const delay = (sent - layout.begun) / period;
    delays.push(delay);
    if (delay > 4) failures.push(`the layout of ticket ${layout.ticket} committed ${delay} display periods after it began, more than 4`);
  }
  const sorted = [...delays].sort((a, b) => a - b);
  const median = sorted.length ? at(sorted, 0.5) : null;
  const p90 = sorted.length ? at(sorted, 0.9) : null;
  if (median !== null && median > 2.5) failures.push(`the median delay is ${median} display periods, more than 2.5`);
  if (p90 !== null && p90 > 3) failures.push(`the 90th percentile delay is ${p90} display periods, more than 3`);
  return { delays, median, p90, longest: sorted.at(-1) ?? null, failures };
}

/**
 * The layout of the last input `lastInput` (ms) of a drag follows the layout pipeline, in display periods (`period`, ms): one
 * preparation runs at a time, so that layout, the first layout that began at or after the last input, begins at the first animation
 * frame after the presentation of the layout that was in flight at the input (its `presented`, or its sending when it records no
 * presentation), or after the input when none was in flight. It is sent at most five display periods after that presentation or input,
 * one for the animation frame and four for the layout, and the layout in flight and the layout of the last input are each sent within
 * four display periods after they began. A last input that began no layout changed nothing: the window keeps the layout in
 * flight, or the one sent before the input. A cancelled layout was replaced and is not counted.
 */
export function lastInputLatency(layouts, { lastInput, period }) {
  const limit = 5 * period;
  const live = layouts.filter((layout) => layout.begun !== null && layout.commitPath !== "cancel").sort((a, b) => a.begun - b.begun);
  const failures = [];
  if (!live.some((layout) => sentAt(layout) !== null)) failures.push("the drag sent no layout");
  const ended = (layout) => layout.presented ?? sentAt(layout);
  const open = (layout) => layout.begun < lastInput && (ended(layout) === null || ended(layout) > lastInput);
  const inFlight = live.filter(open).at(-1);
  const last = live.find((layout) => layout.begun >= lastInput);
  for (const layout of [inFlight, last]) {
    if (layout === undefined) continue;
    const sent = sentAt(layout);
    if (sent === null) {
      failures.push(`the layout of ticket ${layout.ticket} began at ${layout.begun} ms and was not sent`);
    } else if (sent - layout.begun > 4 * period) {
      const periods = (sent - layout.begun) / period;
      failures.push(`the layout of ticket ${layout.ticket} was sent ${periods} display periods after it began, more than 4`);
    }
  }
  const from = inFlight === undefined ? lastInput : ended(inFlight);
  const sent = last === undefined ? null : sentAt(last);
  const delay = from === null || sent === null ? null : sent - from;
  if (delay !== null && delay > limit) {
    const after = inFlight === undefined ? "the last input" : `the presentation of ticket ${inFlight.ticket} in flight at the last input`;
    failures.push(`the layout of the last input was sent ${delay} ms after ${after}, more than ${limit} ms`);
  }
  return {
    inFlight: inFlight?.ticket ?? null, from, ticket: last?.ticket ?? null, begun: last?.begun ?? null, sent, delay, limit, failures,
  };
}

/** Whether `a` and `b` have the same width and height. */
const sameSize = (a, b) => a.width === b.width && a.height === b.height;

/**
 * A maximise or restore keeps the layout at the window size within `limit` ms (150): the time from the first window resize of the
 * gesture to the sending of the first layout that the page laid out at the final content size. `resizes` are the window resize
 * events of the gesture, `{at, width, height}`: the time (ms) and the content size (points) that the event recorded; the final size
 * is that of the last one. The viewport of a layout is the size that the page laid it out at, which the page gave with its
 * preparation; the page can lay out the final size before the host reads it from the window, so the layout can begin before the
 * last resize event. A resize that recorded no size is a failure.
 */
export function catchUp(layouts, resizes, { limit = 150 } = {}) {
  if (resizes.length === 0) return { took: null, limit, ticket: null, size: null, failures: ["the gesture has no window resize"] };
  const sorted = [...resizes].sort((a, b) => a.at - b.at);
  const unsized = sorted.filter(({ width, height }) => !Number.isFinite(width) || !Number.isFinite(height));
  if (unsized.length > 0) {
    return { took: null, limit, ticket: null, size: null,
      failures: unsized.map(({ at }) => `the window resize at ${at} ms recorded no content size`) };
  }
  const first = sorted[0].at;
  const size = { width: sorted.at(-1).width, height: sorted.at(-1).height };
  const caught = layouts.filter((layout) => layout.begun !== null && layout.viewport && sameSize(layout.viewport, size)
    && sentAt(layout) !== null).sort((a, b) => a.begun - b.begun)[0];
  if (caught === undefined) {
    return { took: null, limit, ticket: null, size,
      failures: [`no layout was laid out at the window size ${size.width} x ${size.height}`] };
  }
  const took = sentAt(caught) - first;
  const failures = took > limit ? [`the layout at the window size was sent ${took} ms after the first resize, more than ${limit} ms`] : [];
  return { took, limit, ticket: caught.ticket, size, failures };
}

/** The content frames of `frames` whose mapped time meets the time from `from` to `to` (ms). */
const framesIn = (frames, from, to) => frames.filter(({ timeRange }) => timeRange.upperMs >= from && timeRange.lowerMs <= to);

/**
 * The content frames that a view draws during a drag, from its first step `from` to its last step `to` (ms), follow one another
 * within `limit` ms (40) on the clock of the view. Fewer than two content frames during the drag is a failure.
 */
export function contentCadence(frames, { from, to, limit = 40 }) {
  const during = framesIn(frames, from, to);
  const intervals = during.slice(1).map((frame, index) => frame.frameTimeMs - during[index].frameTimeMs);
  const failures = [];
  if (during.length < 2) failures.push(`the view drew ${during.length} content frames during the drag, fewer than 2`);
  intervals.forEach((interval, index) => {
    if (interval > limit) {
      failures.push(`the content frame at ${during[index + 1].frameTimeMs} ms followed the frame before it after ${interval} ms, ` +
        `more than ${limit} ms`);
    }
  });
  return { count: during.length, intervals, limit, failures };
}

/**
 * When the final size of a view differs from its last size during a drag that ended at `end` (ms), its first content frame at the
 * final size after the drag is drawn within `limit` ms (40) after `end`, by the upper bound of its mapped time. The final size is
 * that of the last content frame.
 */
export function contentConvergence(frames, { end, limit = 40 }) {
  const during = frames.filter(({ timeRange }) => timeRange.lowerMs <= end);
  if (during.length === 0) return { applicable: true, took: null, limit, failures: ["the view drew no content frame during the drag"] };
  const final = frames.at(-1);
  if (sameSize(during.at(-1), final)) return { applicable: false, took: null, limit, failures: [] };
  const drawn = frames.slice(during.length).find((frame) => sameSize(frame, final));
  const took = drawn.timeRange.upperMs - end;
  const failures = took > limit ? [`the view drew its final size ${took} ms after the drag, more than ${limit} ms`] : [];
  return { applicable: true, took, limit, failures };
}

/**
 * After a card layout change whose first layout began at `began` and whose first layout was sent at `changedAt` (ms), the view draws
 * its content at the new size within `limit` ms (100) of `changedAt`, by the upper bound of the mapped time of its first content frame
 * at that size. The frames of the change are those from `began`: the view can draw its new size before the layout that placed it is
 * sent, and such a frame meets the limit. The new size is that of the last content frame, and it differs from the size of the last
 * content frame before the change.
 */
export function contentAfterChange(frames, { began, changedAt, limit = 100 }) {
  const before = frames.filter(({ timeRange }) => timeRange.upperMs < began).at(-1);
  if (before === undefined) return { took: null, limit, failures: ["the view drew no content frame before the change"] };
  const final = frames.at(-1);
  if (sameSize(before, final)) return { took: null, limit, failures: ["the view drew no new size after the change"] };
  const drawn = frames.find((frame) => frame.timeRange.upperMs >= began && sameSize(frame, final));
  const took = drawn.timeRange.upperMs - changedAt;
  const failures = took > limit ? [`the view drew its new size ${took} ms after the change, more than ${limit} ms`] : [];
  return { took, limit, failures };
}
