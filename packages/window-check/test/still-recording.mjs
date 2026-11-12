// A still recording as the host writes it, for the checks of the readers of recordings: one frame file per written still
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

/**
 * Writes a recording into `frames`: still i is planned at i·gap from 0 until `until` (ms) and requested at its plan, or `late`
 * ms later for the indices in `lateBy`, and completes `took` ms after its request. A still shows the number of times in
 * `changes` at or before its request, so a change is first held by the first still requested at or after it. The stills of
 * `failed` fail and those of `notRequested`, and every still from the index `stoppedAt` on (a recording stopped before the end
 * of its plan), are not requested; neither writes a frame. `windows` is the window list of each still. Returns the stop reply of
 * the host, with `layouts` and the display link `displayLink` when given.
 */
export function writeStillRecording(frames, { gap = 8, until, changes = [], took = 0.5, failed = [], notRequested = [],
  stoppedAt = Infinity, lateBy = {}, windows = [7], layouts = [], displayLink } = {}) {
  mkdirSync(frames, { recursive: true });
  const rows = [];
  for (let index = 0; index * gap <= until; index++) {
    const planned = index * gap;
    if (index >= stoppedAt || notRequested.includes(index)) {
      rows.push({ index, planned: ns(planned), requested: null, completed: null, outcome: "not-requested", error: null,
        frame: null, windows: null, requestedGap: gap, machTimebaseNumerator: 1, machTimebaseDenominator: 1 });
      continue;
    }
    const requested = planned + (lateBy[index] ?? 0);
    const completed = requested + took;
    if (failed.includes(index)) {
      rows.push({ index, planned: ns(planned), requested: ns(requested), completed: ns(completed), outcome: "failed",
        error: "the window server returned no image", frame: null, windows, requestedGap: gap, machTimebaseNumerator: 1,
        machTimebaseDenominator: 1 });
      continue;
    }
    const frame = `frame-${String(index).padStart(4, "0")}.bgra`;
    writeFileSync(join(frames, frame), stillFrame(changes.filter((at) => at <= requested).length, requested, completed));
    rows.push({ index, planned: ns(planned), requested: ns(requested), completed: ns(completed), outcome: "written",
      error: null, frame, windows, requestedGap: gap, machTimebaseNumerator: 1, machTimebaseDenominator: 1 });
  }
  const stills = join(frames, "stills.jsonl");
  writeFileSync(stills, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const written = rows.filter((row) => row.outcome === "written");
  const requestedMs = written.map((row) => Number(row.requested) / 1e6);
  const longestGap = Math.max(0, ...requestedMs.slice(1).map((ms, i) => ms - requestedMs[i]));
  let link;
  if (displayLink !== undefined) {
    link = join(frames, "display-link.json");
    writeFileSync(link, JSON.stringify(displayLink));
  }
  return { frames, stills, ...(link ? { displayLink: link } : {}), count: written.length, missed: rows.length - written.length,
    late: Object.keys(lateBy).filter((index) => lateBy[index] > gap).length, longestGap, layouts };
}
