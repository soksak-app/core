// The CPU cost of clicks on cards whose view holds a native image region (e2e/benchmark/click-cpu.test.mjs): a grid of two rows of
// five raster probe cards (openRasterGrid of raster-cards.mjs, balanced with core.layout.balance), then CLICKS native clicks, a press
// and a release of input.pointer, at the centre of the image region of each card in turn, each followed by the wait until core.grid
// names the clicked card focused. It measures the CPU time of the host, the web content processes, the sidecars and the other WebKit
// services over all clicks (measureCpu of process-cpu.mjs) and, for each click, the time from the press to the core.grid value that
// names the card focused, as the check observes it: the round trips of the endpoint are part of that time.
import { traceSettings } from "../../../scripts/measure-trace.mjs";
import { fresh } from "../../fixture.mjs";
import { imagePoint } from "../../input-probe.mjs";
import { fixtureSettings } from "./b3-run.mjs";
import { clockMs } from "./layout-redraw.mjs";
import { measureCpu, percentile } from "./process-cpu.mjs";
import { openRasterGrid } from "./raster-cards.mjs";

/** The grid of the benchmark and the number of its clicks. */
export const CLICK_GRID = Object.freeze({ rows: 2, columns: 5 });
export const CLICKS = 100;
/** The clicks after the measured CPU interval whose time from the press to the display of the focus is read. */
export const DISPLAY_CLICKS = 20;

/**
 * The order of the clicks over `cards` ({card} in the order of the grid) for `count` clicks: each card in turn, starting at the card
 * after `focused`, so that every click moves the focus to another card.
 */
export function clickOrder(cards, focused, count) {
  const first = (cards.findIndex(({ card }) => card === focused) + 1) % cards.length;
  return Array.from({ length: count }, (_, index) => cards[(first + index) % cards.length]);
}

/** The figures of the times from press to focus `times` (ms): their count, median, 90th percentile, largest and sum. */
export function focusTimes(times) {
  return { count: times.length, medianMs: percentile(times, 50), p90Ms: percentile(times, 90), maxMs: Math.max(...times),
    sumMs: times.reduce((sum, time) => sum + time, 0) };
}

/**
 * The figures of the times from press to display `times` (ms) in display periods of the refresh rate `refreshRate` (Hz) of the
 * window (host.window), each rounded to a thousandth: their count, median, 90th percentile and largest. A rate that is not a
 * positive number is an error, because the period of the display is then unknown.
 */
export function displayFrames(times, refreshRate) {
  if (!(Number.isFinite(refreshRate) && refreshRate > 0)) throw new Error(`the refresh rate ${refreshRate} of the window is not a positive number`);
  const frames = times.map((ms) => Math.round((ms * refreshRate) / 1000 * 1000) / 1000);
  return { count: frames.length, medianFrames: percentile(frames, 50), p90Frames: percentile(frames, 90), maxFrames: Math.max(...frames) };
}

/**
 * Clicks the centre `point` of the card `card` and returns the milliseconds from the press to the first core.grid value that names
 * the card focused. The watch starts before the press, so the value that the click causes is not missed.
 */
export async function clickToFocus(s, { card, point }) {
  let focusedAt;
  const focused = s.until("core.grid", (grid) => {
    const yes = grid.cards.some((item) => item.id === card && item.focused === true);
    if (yes && focusedAt === undefined) focusedAt = performance.now();
    return yes;
  }, `the click at ${point.x},${point.y} did not focus the card ${card}`);
  const pressed = performance.now();
  await s.click(point.x, point.y);
  await focused;
  return focusedAt - pressed;
}

/**
 * Clicks the centre `point` of the card `card` and returns the milliseconds from the press to the display time of the presented
 * state that shows the card focused (host.window.presented, docs/spec/exposure.md), both on the clock of diagnostics.clock. The
 * clock is read before the press, so the time holds one round trip of the endpoint more than the window took.
 */
export async function clickToDisplay(s, { card, point }) {
  const focused = s.until("core.grid", (grid) => grid.cards.some((item) => item.id === card && item.focused === true),
    `the click at ${point.x},${point.y} did not focus the card ${card}`);
  const pressed = await clockMs(s);
  await s.click(point.x, point.y);
  await focused;
  const { displayed } = await s.presented();
  return displayed - pressed;
}

/**
 * Runs the benchmark in the window of `s`: the fresh start state in the trace state 0 (traceSettings of scripts/measure-trace.mjs),
 * the grid, and the clicks. Returns `{cards, cpu, focus}`: the number of cards, the CPU report of the clicks and the figures of the
 * times from press to focus (focusTimes), and `display`, the figures of DISPLAY_CLICKS further clicks from the press to the display
 * of the focus (clickToDisplay) in milliseconds (focusTimes) and in display periods of the window (displayFrames).
 */
export async function runClicks(s) {
  await fresh(s, fixtureSettings(traceSettings(0)));
  const cards = (await openRasterGrid(s, { ...CLICK_GRID, balance: true })).flat();
  // The image regions keep their places during the clicks, so each centre is read once.
  const targets = [];
  for (const { card, surface } of cards) targets.push({ card, point: await imagePoint(s, surface) });
  const focused = (await s.get("core.grid")).cards.find((item) => item.focused)?.id;
  const order = clickOrder(targets, focused, CLICKS);
  const { value: times, cpu } = await measureCpu(s, CLICKS, async () => {
    const measured = [];
    for (const target of order) measured.push(await clickToFocus(s, target));
    return measured;
  });
  const { refreshRate } = await s.get("host.window");
  const displayTimes = [];
  for (const target of clickOrder(targets, order.at(-1).card, DISPLAY_CLICKS)) displayTimes.push(await clickToDisplay(s, target));
  return { cards: cards.length, cpu, focus: focusTimes(times),
    display: { refreshRate, ...focusTimes(displayTimes), ...displayFrames(displayTimes, refreshRate) } };
}
