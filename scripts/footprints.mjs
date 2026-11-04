// The footprint readings of the measurement targets: the phys_footprint and the phys_footprint_peak of a process that
// `footprint -p PID -f bytes` prints, and the settle rule of G3 (docs/plans/mygo-host.md): a footprint is read after two consecutive
// readings of every process 5 seconds apart differ by less than 1,024 KB, and at least 3 seconds after the last frame of every window
// whose host.window counts its frames. `make app-usage` and `make host-allocations` read their footprints through this module.

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
 * Reads the footprint and its lifetime peak of the process pid, in bytes, with `footprint -p PID -f bytes`. run(command, args) resolves to
 * {status, stdout, stderr, error}; a failed command or an output without the two lines is an error that names the process.
 */
export async function readFootprint(pid, run) {
  const result = await run("footprint", ["-p", String(pid), "-f", "bytes"]);
  if (result.error) throw new Error(`footprint -p ${pid}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`footprint -p ${pid} exited with ${result.status}: ${String(result.stderr).trim()}`);
  try {
    return { bytes: parseFootprint(result.stdout), peakBytes: parseFootprintPeak(result.stdout) };
  } catch (error) {
    throw new Error(`footprint -p ${pid}: ${error.message}`);
  }
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
 * Reads the footprints until they settle by the rule of G3 and returns the settled reading { footprints, frames }. Each reading reads
 * the frames of the windows, waits 3 seconds, reads the footprints and reads the frames again; the reading is after the last frame when
 * both frame readings are equal, a window whose frames is null counting no frame, and the next reading starts 5 seconds after the one
 * before it. The reading is settled when it is after the last frame and each footprint differs by less than 1,024 KB from the reading
 * before it. readFootprints() resolves to a Map pid -> bytes, readFrames() to the frames of each window, and sleep(ms) waits. The waits
 * are the rule itself: no status announces a settled footprint, and the host notifies host.window watchers when settled changes, not at
 * each frame. Footprints that do not settle within `readings` readings fail with the last two readings.
 */
export async function settledFootprints({ readFootprints, readFrames, sleep, readings = SETTLE_READINGS }) {
  if (readings < 2) throw new Error(`settledFootprints needs at least 2 readings, not ${readings}`);
  let previous = null;
  for (let reading = 1; ; reading++) {
    if (previous !== null) await sleep(SETTLE_RULE.intervalMs - SETTLE_RULE.quietMs);
    const framesBefore = await readFrames();
    await sleep(SETTLE_RULE.quietMs);
    const footprints = await readFootprints();
    const frames = await readFrames();
    const quiet = sameFrames(framesBefore, frames);
    if (previous !== null && quiet && closeTo(previous.footprints, footprints)) return { footprints, frames };
    if (reading === readings) {
      const changes = [...footprints].map(([pid, bytes]) =>
        `pid ${pid}: ${previous.footprints.has(pid) ? kilobytes(previous.footprints.get(pid)) : "no"} KB then ${kilobytes(bytes)} KB`);
      throw new Error(`the footprints did not settle within ${readings} readings 5 s apart; ${changes.join(", ")}; ` +
        `frames ${framesText(framesBefore)} then ${framesText(frames)} in the last 3 s`);
    }
    previous = { footprints, frames };
  }
}
