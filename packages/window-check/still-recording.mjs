// A still recording as the host writes it, for the unit checks of the readers of recordings: one frame file per written still
// (frame-<index>.bgra, marker LZ4S) and one stills.jsonl row per planned still, on a timebase of nanoseconds.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { crc32 } from "node:zlib";

/** The bytes of a frame of one black pixel, requested and completed at those times (ms). */
export function stillFrame(requested, completed) {
  const pixels = Buffer.from([0, 0, 0, 255]);
  // An LZ4 block of one literal run of four bytes.
  const block = Buffer.concat([Buffer.from([0x40]), pixels]);
  const header = Buffer.alloc(88);
  header.writeUInt32LE(1, 0); header.writeUInt32LE(1, 4); header.writeUInt32LE(4, 8);
  [0, 0, 1, 1, 1, 1, requested, completed].forEach((value, i) => header.writeDoubleLE(value, 12 + i * 8));
  header.write("LZ4S", 76); header.writeUInt32LE(block.length, 80); header.writeUInt32LE(crc32(pixels), 84);
  return Buffer.concat([header, block]);
}

const ns = (ms) => String(Math.round(ms * 1e6));

/** The stage times of a still row (docs/spec/diagnostics.md, stills.jsonl), each null: no stage ran. */
const NO_STAGES = Object.fromEntries(["writeStartTime", "writeCompleteTime", "writerEnqueuedTime", "writerStartTime",
  "writerCompleteTime"].map((name) => [name, null]));

/** The ICC profile of the frames of the fixture recordings, and its file name in a recording folder. */
export const FIXTURE_PROFILE = Buffer.from("soksak fixture ICC profile");
export const FIXTURE_PROFILE_FILE = `color-${createHash("sha256").update(FIXTURE_PROFILE).digest("hex").slice(0, 16)}.icc`;

/**
 * The fields of a still row that the processing of its image writes: for a written still completed at the raw mach time
 * `completed`, its processing and frame write, all at that time, and the colour space of its frame, a display
 * space without a name and the profile FIXTURE_PROFILE_FILE; for another still, none.
 */
export function stillFields(written, completed) {
  return written ? { ...NO_STAGES, writeStartTime: completed, writeCompleteTime: completed, writerEnqueuedTime: completed,
    writerStartTime: completed, writerCompleteTime: completed,
    colorSpace: null, colorProfile: FIXTURE_PROFILE_FILE }
    : { ...NO_STAGES, colorSpace: null, colorProfile: null };
}

/**
 * Writes a recording into `frames`: still i is planned at i·gap from 0 until `until` (ms) and requested at its plan, or `late`
 * ms later for the indices in `lateBy`, and completes `took` ms after its request. The stills of
 * `failed` fail and those of `notRequested`, and every still from the index `stoppedAt` on (a recording stopped before the end
 * of its plan), are not requested; neither writes a frame. `windows` is the window list of each still. Returns the stop reply of
 * the host, which names the recorded window `window` (null for a recording of the display), with `layouts` when given.
 */
export function writeStillRecording(frames, { gap = 8, until, took = 0.5, failed = [], notRequested = [],
  stoppedAt = Infinity, lateBy = {}, windows = [7], window = 7, layouts = [] } = {}) {
  mkdirSync(frames, { recursive: true });
  const rows = [];
  for (let index = 0; index * gap <= until; index++) {
    const planned = index * gap;
    if (index >= stoppedAt || notRequested.includes(index)) {
      rows.push({ index, planned: ns(planned), requested: null, completed: null, outcome: "not-requested", error: null,
        frame: null, windows: null, requestedGap: gap, machTimebaseNumerator: 1, machTimebaseDenominator: 1, ...stillFields(false) });
      continue;
    }
    const requested = planned + (lateBy[index] ?? 0);
    const completed = requested + took;
    if (failed.includes(index)) {
      rows.push({ index, planned: ns(planned), requested: ns(requested), completed: ns(completed), outcome: "failed",
        error: "the window server returned no image", frame: null, windows, requestedGap: gap, machTimebaseNumerator: 1,
        machTimebaseDenominator: 1, ...stillFields(false) });
      continue;
    }
    const frame = `frame-${String(index).padStart(4, "0")}.bgra`;
    writeFileSync(join(frames, frame), stillFrame(requested, completed));
    rows.push({ index, planned: ns(planned), requested: ns(requested), completed: ns(completed), outcome: "written",
      error: null, frame, windows, requestedGap: gap, machTimebaseNumerator: 1, machTimebaseDenominator: 1,
      ...stillFields(true, ns(completed)) });
  }
  const stills = join(frames, "stills.jsonl");
  writeFileSync(stills, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const written = rows.filter((row) => row.outcome === "written");
  // The first written still writes the profile of its colour space.
  if (written.length > 0) writeFileSync(join(frames, FIXTURE_PROFILE_FILE), FIXTURE_PROFILE);
  const longestGap = Math.max(0, ...written.slice(1).map((row, i) => Number(BigInt(row.requested) - BigInt(written[i].requested)) / 1e6));
  return { frames, stills, window, count: written.length, missed: rows.length - written.length,
    late: Object.keys(lateBy).filter((index) => lateBy[index] > gap).length, longestGap, layouts };
}
