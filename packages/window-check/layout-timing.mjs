// Judgments of the timing of layouts and of the content frames of views, from the numbers that the host and the views report: the
// layout transactions of the layout trace ({ticket, begun, requested, presented, committed, commitPath, openAtCommit, flushed}, ms on
// the host monotonic clock), the times of the steps of a drag, the window resize events and the content frames that a view traces
// (viewContentFrameEvents of view-metrics-collection.mjs). No judgment reads a recorded frame. Each judgment returns its measured
// values with `failures`, the requirements that the values miss, which is empty when they meet them.
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
 * The commits of a view drag follow one another within two display periods (`period`, ms): the intervals between the sending
 * times (sentAt) of the layouts that began from the first step `from` to the last step `to` of the drag. Fewer than two such
 * commits is a failure.
 */
export function commitCadence(layouts, { from, to, period }) {
  const limit = 2 * period;
  const sent = begunIn(layouts, from, to).map(sentAt).filter((time) => time !== null).sort((a, b) => a - b);
  const intervals = sent.slice(1).map((time, index) => time - sent[index]);
  const failures = [];
  if (sent.length < 2) failures.push(`the drag committed ${sent.length} layouts from ${from} to ${to} ms, fewer than 2`);
  intervals.forEach((interval, index) => {
    if (interval > limit) {
      failures.push(`the commit at ${sent[index + 1]} ms followed the commit before it after ${interval} ms, more than ${limit} ms`);
    }
  });
  return { count: sent.length, intervals, limit, failures };
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
 * The last layout of a drag is sent within two display periods (`period`, ms) after its last input `lastInput` (ms): the layout
 * that the window keeps after the drag is the last one the trace sent, and a last step that changes nothing keeps the layout sent
 * before it.
 */
export function lastInputConvergence(layouts, { lastInput, period }) {
  const limit = 2 * period;
  const sent = layouts.map(sentAt).filter((time) => time !== null);
  if (sent.length === 0) return { settled: null, delay: null, limit, failures: ["the drag sent no layout"] };
  const settled = Math.max(...sent);
  const delay = settled - lastInput;
  const failures = delay > limit ? [`the last layout was sent ${delay} ms after the last input, more than ${limit} ms`] : [];
  return { settled, delay, limit, failures };
}

/**
 * A maximise or restore keeps the layout at the window size within `limit` ms (150): the time from the first window resize of the
 * gesture to the sending of the first layout that began at or after its last resize, which is laid out at the final window size.
 * `resizes` are the times (ms) of the window resize events of the gesture.
 */
export function catchUp(layouts, resizes, { limit = 150 } = {}) {
  if (resizes.length === 0) return { took: null, limit, ticket: null, failures: ["the gesture has no window resize"] };
  const sorted = [...resizes].sort((a, b) => a - b);
  const [first, last] = [sorted[0], sorted.at(-1)];
  const caught = layouts.filter((layout) => layout.begun !== null && layout.begun >= last && sentAt(layout) !== null)
    .sort((a, b) => a.begun - b.begun)[0];
  if (caught === undefined) return { took: null, limit, ticket: null, failures: [`no layout began after the last resize at ${last} ms`] };
  const took = sentAt(caught) - first;
  const failures = took > limit ? [`the layout at the window size was sent ${took} ms after the first resize, more than ${limit} ms`] : [];
  return { took, limit, ticket: caught.ticket, failures };
}

/** The content frames of `frames` whose mapped time meets the time from `from` to `to` (ms). */
const framesIn = (frames, from, to) => frames.filter(({ timeRange }) => timeRange.upperMs >= from && timeRange.lowerMs <= to);

const sameSize = (a, b) => a.width === b.width && a.height === b.height;

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
