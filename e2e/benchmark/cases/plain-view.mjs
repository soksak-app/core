// The plain view probe of the plain view benchmark (plain-view.test.mjs) and window check (e2e/plain-view.test.mjs): its content
// trace, its opening to the right of a card, its drag and card size change, and the summary of its source intervals.
import assert from "node:assert/strict";

import { drag } from "@soksak/window-check/app.mjs";
import { sentAt } from "@soksak/window-check/layout-timing.mjs";
import { rightEdgeWidthDragPlan, withViewContentTrace } from "@soksak/window-check/view-metrics-collection.mjs";

/** The view descriptor of the plain view probe: its plugin and the start and stop of its content trace. */
export const PLAIN_VIEW = Object.freeze({
  plugin: "probeplain",
  startContentTrace: (s, surface) => s.run("probeplain.measure", { action: "start" }, surface),
  stopContentTrace: (s, surface) => s.run("probeplain.measure", { action: "stop" }, surface),
});

/** Prepares the window, opens the probe, which every check configuration has installed, to the right of a card and returns the session state of its drag. */
export async function openPlainView(s, prepare) {
  await prepare();
  const anchor = (await s.get("core.grid")).cards.find((item) => item.pane !== null);
  const split = await s.run("core.card.split", { card: anchor.id, side: "right", plugin: PLAIN_VIEW.plugin });
  // The view registers its command after its phase ready, so a trace that starts at once can reach a view without it.
  await s.registered(split.tab, ["command probeplain.measure"]);
  const grid = await s.get("core.grid");
  await s.presented();
  return { surface: split.tab, grid, card: grid.cards.find((item) => item.id === split.card) };
}

/**
 * Under the content trace of the plain view `surface`, drags the right edge of its card `card` (with `capture`, under a recording that
 * is its log) and then makes the card 80 pt wider under the layout trace until that layout is displayed. Returns the traced content
 * frames and `{dragged, changed}`: the drag result and the sending time (sentAt) of the first layout of the card change that was
 * sent, or null.
 */
export function dragAndWiden(t, s, { surface, grid, card }, { capture = false } = {}) {
  return withViewContentTrace(t, s, PLAIN_VIEW, surface, async () => {
    const dragged = await drag(s, rightEdgeWidthDragPlan(grid, card), { capture });
    const width = card.w + 80;
    const { layouts } = await s.traceLayouts(async () => {
      await s.run("core.grid.size", { card: card.id, axis: "x", size: width });
      await s.until("core.grid", (value) => Math.abs(value.cards.find((item) => item.id === card.id).w - width) < 1,
        `card ${card.id} did not become ${width} pt wide`);
      await s.presented();
    });
    return { dragged, changed: layouts.map(sentAt).filter((time) => time !== null).sort((a, b) => a - b)[0] ?? null };
  });
}

/** The count and the median, p90 and largest interval (ms) between the source frames whose time range meets the gesture. */
export function sourceIntervalSummary(sourceFrames, gestureStartedAtMs, gestureEndedAtMs) {
  assert.ok(Array.isArray(sourceFrames), "source frames must be an array");
  const inGesture = sourceFrames.filter(({ timeRange }) => timeRange.upperMs >= gestureStartedAtMs && timeRange.lowerMs <= gestureEndedAtMs);
  const intervals = inGesture.slice(1).map((frame, index) => frame.frameTimeMs - inGesture[index].frameTimeMs).sort((a, b) => a - b);
  if (intervals.length === 0) return { count: inGesture.length, medianMs: null, p90Ms: null, maxMs: null };
  return {
    count: inGesture.length,
    medianMs: intervals[Math.floor(intervals.length / 2)],
    p90Ms: intervals[Math.floor(intervals.length * 0.9)],
    maxMs: intervals.at(-1),
  };
}
