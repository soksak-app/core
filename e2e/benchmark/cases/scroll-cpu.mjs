// The CPU cost of scrolling a card whose sidecar retains many lines (e2e/benchmark/scroll-cpu.test.mjs): one raster probe card
// (openRasterGrid of raster-cards.mjs) whose session retains HISTORY lines (rasterprobe.history), as a terminal retains its
// scrollback, and whose frames paint a row band for every row of its grid, a band as long as the line it shows. Native wheel input
// (input.pointer `scroll`) at the centre of its image region moves the viewport STEP_LINES lines at a time from the newest line to
// the oldest and back; after each wheel the benchmark waits until rasterprobe.session names the answer of that wheel and, when the
// offset moved, until the image region presents the frame of the new offset. It measures the CPU time of the host, the web content
// processes, the sidecars and the other WebKit services over the whole scroll (measureCpu of process-cpu.mjs).
import { traceSettings } from "../../../scripts/measure-trace.mjs";
import { fresh } from "../../fixture.mjs";
import { imagePoint } from "../../input-probe.mjs";
import { presentedFrame } from "../../raster-probe.mjs";
import { fixtureSettings } from "./b3-run.mjs";
import { measureCpu, percentile } from "./process-cpu.mjs";
import { openRasterGrid } from "./raster-cards.mjs";

/** The lines that the session retains, the lines of one wheel, and the row bands that the frames paint (every row of the grid). */
export const HISTORY = 10000;
export const STEP_LINES = 100;
const ALL_ROWS = 100000;

/**
 * The wheel distance in points (`deltaY` of input.pointer) of `lines` lines toward older lines for the frame `frame`
 * (rasterprobe.frame), whose cell is grid.cellHeight device pixels at its scale. A wheel that moves the content down shows older
 * lines, and its deltaY is negative; the native input takes whole points, so the distance is rounded.
 */
export function wheelDelta(frame, lines) {
  const cell = frame.grid.cellHeight / frame.scale;
  if (!(cell > 0)) throw new Error(`the frame ${JSON.stringify(frame)} has no cell height`);
  return -Math.round(lines * cell);
}

/**
 * The next offset after a wheel from `offset` toward `direction` (1 older, -1 newer) answered `answered`, or an error when the
 * wheel did not move toward `direction`: a wheel that moves nothing would make the scroll endless, and one that moves the other way
 * names the sign of the native wheel.
 */
export function steppedOffset({ offset, direction, answered, deltaY }) {
  if (Math.sign(answered - offset) !== direction) {
    throw new Error(`the wheel of deltaY ${deltaY} moved the scrollback offset from ${offset} to ${answered}, not toward ` +
      `${direction > 0 ? "older" : "newer"} lines`);
  }
  return answered;
}

/**
 * Sends one wheel of `deltaY` at `point` and returns the offset that rasterprobe.session of `surface` names in the answer of the
 * wheel; when the offset moved, it also waits until the image region presents a frame of that offset.
 */
async function wheel(s, surface, point, deltaY) {
  const before = (await s.get("rasterprobe.session", surface)).scrollback;
  await s.pointer(point.x, point.y, "scroll", { deltaY });
  const { scrollback } = await s.until("rasterprobe.session", (value) => value.scrollback?.sequence > before.sequence,
    `the wheel of deltaY ${deltaY} at ${point.x},${point.y} was not answered after wheel ${before.sequence}`, { surface });
  if (scrollback.offset !== before.offset) {
    await presentedFrame(s, surface, (frame) => frame.scrollback?.offset === scrollback.offset, `a frame of the offset ${scrollback.offset}`);
  }
  return scrollback.offset;
}

/**
 * Scrolls `surface` from the newest line to the oldest and back with wheels of `deltaY` (toward older lines; its negation toward
 * newer ones) at `point`, and returns the milliseconds of each wheel. A scroll that takes more wheels than the history needs fails.
 */
async function scrollThrough(s, surface, point, deltaY) {
  const times = [];
  const most = Math.ceil(HISTORY / STEP_LINES) + 1;
  for (const [direction, delta, end] of [[1, deltaY, HISTORY], [-1, -deltaY, 0]]) {
    let offset = (await s.get("rasterprobe.session", surface)).scrollback.offset;
    for (let count = 0; offset !== end; count++) {
      if (count === most) throw new Error(`${most} wheels did not move the scrollback offset from ${offset} to ${end}`);
      const started = performance.now();
      offset = steppedOffset({ offset, direction, answered: await wheel(s, surface, point, delta), deltaY: delta });
      times.push(performance.now() - started);
    }
  }
  return times;
}

/**
 * Runs the benchmark in the window of `s`: the fresh start state in the trace state 0, one raster probe card in the first row of the
 * start layout, its history of HISTORY lines, and the scroll. Returns `{wheels, cpu, wheel}`: the number of wheels, the CPU report of
 * the scroll and the median, 90th percentile and largest milliseconds of a wheel from its input to its presented frame.
 */
export async function runScroll(s) {
  await fresh(s, fixtureSettings(traceSettings(0)));
  const [[{ surface }]] = await openRasterGrid(s, { rows: 1, columns: 1, balance: false });
  await s.run("rasterprobe.rows", { count: ALL_ROWS }, surface);
  await s.run("rasterprobe.history", { count: HISTORY }, surface);
  await s.until("rasterprobe.session", (value) => value.scrollback?.history === HISTORY && value.scrollback.offset === 0,
    `the raster probe ${surface} did not retain ${HISTORY} lines`, { surface });
  const frame = await presentedFrame(s, surface, (value) => value.scrollback?.history === HISTORY && value.rows > 0,
    `a frame of ${HISTORY} retained lines`);
  const deltaY = wheelDelta(frame, STEP_LINES);
  const point = await imagePoint(s, surface);
  const { value: times, cpu } = await measureCpu(s, 2 * Math.ceil(HISTORY / STEP_LINES), () => scrollThrough(s, surface, point, deltaY));
  if (times.length !== cpu.actions) throw new Error(`the scroll took ${times.length} wheels, not the ${cpu.actions} of ${HISTORY} lines in steps of ${STEP_LINES}`);
  return { wheels: times.length, deltaY, cpu, wheel: { medianMs: percentile(times, 50), p90Ms: percentile(times, 90), maxMs: Math.max(...times) } };
}
