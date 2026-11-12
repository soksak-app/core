// A still recording as the host writes it, for the unit checks of the readers of recordings: one frame file per written still
// (frame-<index>.bgra, marker LZ4S) and one stills.jsonl row per planned still, on a timebase of nanoseconds.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";

/** The bytes of a frame of one pixel whose blue channel is `shade`, requested and completed at those times (ms). */
export function stillFrame(shade, requested, completed) {
  const pixels = Buffer.from([shade & 255, 0, 0, 255]);
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
const NO_STAGES = Object.fromEntries(["writeStartTime", "writeCompleteTime", "imageMatchStartTime", "imageMatchCompleteTime",
  "identityDecodeEnqueueStartTime", "identityDecodeEnqueueCompleteTime", "writerEnqueuedTime", "writerStartTime",
  "writerCompleteTime", "frameIdentityDecodeStartTime", "frameIdentityDecodeCompleteTime"].map((name) => [name, null]));

/**
 * The stage times of a still row: for a written still completed at the raw mach time `completed`, its processing, image match
 * and frame write, all at that time; for another still, none.
 */
export function stillStages(written, completed) {
  return written ? { ...NO_STAGES, writeStartTime: completed, writeCompleteTime: completed, imageMatchStartTime: completed,
    imageMatchCompleteTime: completed, writerEnqueuedTime: completed, writerStartTime: completed, writerCompleteTime: completed }
    : NO_STAGES;
}

/**
 * Writes a recording into `frames`: still i is planned at i·gap from 0 until `until` (ms) and requested at its plan, or `late`
 * ms later for the indices in `lateBy`, and completes `took` ms after its request. A still shows the number of times in
 * `changes` at or before its request, so a change is first held by the first still requested at or after it. The stills of
 * `failed` fail and those of `notRequested`, and every still from the index `stoppedAt` on (a recording stopped before the end
 * of its plan), are not requested; neither writes a frame. `windows` is the window list of each still. Returns the stop reply of
 * the host, which names the recorded window `window` (null for a recording of the display), with `layouts` and the display link
 * `displayLink` when given.
 */
export function writeStillRecording(frames, { gap = 8, until, changes = [], took = 0.5, failed = [], notRequested = [],
  stoppedAt = Infinity, lateBy = {}, windows = [7], window = 7, layouts = [], displayLink } = {}) {
  mkdirSync(frames, { recursive: true });
  const rows = [];
  for (let index = 0; index * gap <= until; index++) {
    const planned = index * gap;
    if (index >= stoppedAt || notRequested.includes(index)) {
      rows.push({ index, planned: ns(planned), requested: null, completed: null, outcome: "not-requested", error: null,
        frame: null, windows: null, requestedGap: gap, machTimebaseNumerator: 1, machTimebaseDenominator: 1, ...stillStages(false) });
      continue;
    }
    const requested = planned + (lateBy[index] ?? 0);
    const completed = requested + took;
    if (failed.includes(index)) {
      rows.push({ index, planned: ns(planned), requested: ns(requested), completed: ns(completed), outcome: "failed",
        error: "the window server returned no image", frame: null, windows, requestedGap: gap, machTimebaseNumerator: 1,
        machTimebaseDenominator: 1, ...stillStages(false) });
      continue;
    }
    const frame = `frame-${String(index).padStart(4, "0")}.bgra`;
    writeFileSync(join(frames, frame), stillFrame(changes.filter((at) => at <= requested).length, requested, completed));
    rows.push({ index, planned: ns(planned), requested: ns(requested), completed: ns(completed), outcome: "written",
      error: null, frame, windows, requestedGap: gap, machTimebaseNumerator: 1, machTimebaseDenominator: 1,
      ...stillStages(true, ns(completed)) });
  }
  const stills = join(frames, "stills.jsonl");
  writeFileSync(stills, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const written = rows.filter((row) => row.outcome === "written");
  const longestGap = Math.max(0, ...written.slice(1).map((row, i) => Number(BigInt(row.requested) - BigInt(written[i].requested)) / 1e6));
  let link;
  if (displayLink !== undefined) {
    link = join(frames, "display-link.json");
    writeFileSync(link, JSON.stringify(displayLink));
  }
  return { frames, stills, window, ...(link ? { displayLink: link } : {}), count: written.length, missed: rows.length - written.length,
    late: Object.keys(lateBy).filter((index) => lateBy[index] > gap).length, longestGap, layouts };
}
