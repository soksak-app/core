// The footprint readings of the measurement targets: the phys_footprint and the phys_footprint_peak of a process that
// `footprint -p PID -f bytes` prints, and the settle rule of G3 (docs/spec/hosts.md): a footprint is read after two consecutive
// readings of every process 5 seconds apart differ by less than 1,024 KB, and at least 3 seconds after the last frame of every window
// whose host.window counts its frames. `make measure-app-usage` and `make measure-host-allocations` read their footprints through this module.
import { delay, execute, instant, remainingMs } from "./measure-tools.mjs";

/** The settle rule of G3: the interval of two readings, the bytes that they differ by at most, and the time after the last frame. */
export const SETTLE_RULE = Object.freeze({ intervalMs: 5000, bytes: 1024 * 1024, quietMs: 3000 });

/** The readings after which footprints that keep changing fail: two minutes, the bound of the idle tab case. */
const SETTLE_READINGS = 24;

/** Reads the phys_footprint of the output of footprint -f bytes, in bytes. The peak and the summary line are not the footprint. */
export function parseFootprint(text) {
  const match = /^\s*phys_footprint: (\d+) B$/m.exec(text);
  if (!match) throw new Error("footprint output has no phys_footprint line");
  return Number(match[1]);
}

/** Reads the lifetime peak of the footprint of the output of footprint -f bytes, in bytes. */
export function parseFootprintPeak(text) {
  const match = /^\s*phys_footprint_peak: (\d+) B$/m.exec(text);
  if (!match) throw new Error("footprint output has no phys_footprint_peak line");
  return Number(match[1]);
}

/**
 * The footprint and its lifetime peak of the process pid, in bytes, from the process result {status, stdout, stderr, error} of
 * `footprint -p PID -f bytes`; a failed command or an output without the two lines is an error that names the process.
 */
export function footprintOfResult(pid, result) {
  if (result.error) throw new Error(`footprint -p ${pid}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`footprint -p ${pid} exited with ${result.status}: ${String(result.stderr).trim()}`);
  try {
    return { bytes: parseFootprint(result.stdout), peakBytes: parseFootprintPeak(result.stdout) };
  } catch (error) {
    throw new Error(`footprint -p ${pid}: ${error.message}`);
  }
}

/** Reads the footprint and its lifetime peak of the process pid, in bytes, with `footprint -p PID -f bytes`. */
export async function readFootprint(pid) {
  return footprintOfResult(pid, await execute("footprint", ["-p", String(pid), "-f", "bytes"]));
}

const sameFrames = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const framesText = (frames) => frames.map(String).join(" ");
const kilobytes = (bytes) => Math.round(bytes / 1024);

/** Whether a reading is settled against the reading before it: the same processes, each closer than SETTLE_RULE.bytes. */
function closeTo(previous, current) {
  if (previous.size !== current.size) return false;
  for (const [pid, bytes] of current) {
    if (!previous.has(pid) || Math.abs(bytes - previous.get(pid)) >= SETTLE_RULE.bytes) return false;
  }
  return true;
}

/**
 * The milliseconds that the settle rule still waits at the instant `now`: wait `quiet` is the 3 seconds after the frames reading at the
 * instant `since`, and wait `interval` is the 5 seconds after the frames reading of the reading before it.
 */
export function settleWaitMs({ wait, since, now }) {
  if (wait !== "quiet" && wait !== "interval") throw new Error(`the settle wait is quiet or interval, not ${JSON.stringify(wait)}`);
  return remainingMs({ since, now, ms: SETTLE_RULE[`${wait}Ms`] });
}

/**
 * The judgement of reading number `reading` of `readings`: `settled` when the reading is after the last frame (both frame readings
 * `framesBefore` and `frames` are equal, a window whose frames is null counting no frame) and each footprint differs by less than
 * 1,024 KB from `previous`, the footprints of the reading before it (null for the first reading); `again` otherwise; and an error with the
 * last two readings when the last reading is not settled.
 */
export function settleStep({ previous, framesBefore, frames, footprints, reading, readings }) {
  if (previous !== null && sameFrames(framesBefore, frames) && closeTo(previous.footprints, footprints)) return "settled";
  if (reading === readings) {
    const changes = [...footprints].map(([pid, bytes]) =>
      `pid ${pid}: ${previous.footprints.has(pid) ? kilobytes(previous.footprints.get(pid)) : "no"} KB then ${kilobytes(bytes)} KB`);
    throw new Error(`the footprints did not settle within ${readings} readings 5 s apart; ${changes.join(", ")}; ` +
      `frames ${framesText(framesBefore)} then ${framesText(frames)} in the last 3 s`);
  }
  return "again";
}

/**
 * Reads the footprints until they settle by the rule of G3 and returns the settled reading { footprints, frames }. Each reading reads
 * the frames of the windows, waits until 3 seconds after that reading (settleWaitMs), reads the footprints and reads the frames again,
 * and the next reading starts 5 seconds after the frames reading of the one before it; settleStep judges each reading.
 * readFootprints() resolves to a Map pid -> bytes and readFrames() to the frames of each window. The waits are the rule itself: no status
 * announces a settled footprint, and the host notifies host.window watchers when settled changes, not at each frame.
 */
export async function settledFootprints({ readFootprints, readFrames, readings = SETTLE_READINGS }) {
  if (readings < 2) throw new Error(`settledFootprints needs at least 2 readings, not ${readings}`);
  let previous = null;
  let previousAt = null;
  for (let reading = 1; ; reading++) {
    if (previous !== null) await delay(settleWaitMs({ wait: "interval", since: previousAt, now: instant() }));
    const framesBefore = await readFrames();
    const framesAt = instant();
    await delay(settleWaitMs({ wait: "quiet", since: framesAt, now: instant() }));
    const footprints = await readFootprints();
    const frames = await readFrames();
    if (settleStep({ previous, framesBefore, frames, footprints, reading, readings }) === "settled") return { footprints, frames };
    previous = { footprints, frames };
    previousAt = framesAt;
  }
}
