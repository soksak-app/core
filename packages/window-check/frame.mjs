// Reads one frame that a capture recorded.
//
// A frame is one still of a recording. It restores all BGRA bytes from an LZ4 block with metadata, the request and the
// completion time of its still and a checksum.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { decodeLz4 } from "./lz4.mjs";

const HEAD = 88;
const MARKER = "LZ4S";

/**
 * Reads one file as { width, height, stride, content, contentScale, scale, requested, completed, data }. content is the
 * rectangle in the buffer where the window is drawn (buffer points). requested and completed are the times (ms, the clock of
 * the layout trace) right before the still was asked of the window server and right after it returned: the still shows the
 * window at one moment between them, so a state that it shows was shown no later than completed, and a state that it does not
 * show was not yet shown at requested.
 *
 * Rejects a short file. A frame that was being written while the recording stopped is cut off, and reading a cut-off
 * position gives undefined, which no color check catches. Left as it is, a broken frame would be treated as a whole
 * frame.
 */
export function readFrame(path) {
  const file = readFileSync(path);
  const head = frameHead(path, file);
  const data = decodeLz4(file.subarray(HEAD), head.stride * head.height);
  if (crc32(data) !== head.checksum) throw new Error(`${path} has an invalid pixel checksum`);
  const { checksum, ...frame } = head;
  return { ...frame, data };
}

/**
 * Reads the header of one frame file as { width, height, stride, content, contentScale, scale, requested, completed, checksum }
 * without restoring its pixels. Rejects a file whose header or compressed block is incomplete, and a frame of the stream
 * recording that the still recording replaced (marker LZ4B, seven float64).
 */
function frameHead(path, file) {
  if (file.length < HEAD || !file.subarray(76, 80).equals(Buffer.from(MARKER))) {
    throw new Error(`${path} has no complete ${MARKER} frame header of a still`);
  }
  const width = file.readUInt32LE(0);
  const height = file.readUInt32LE(4);
  const stride = file.readUInt32LE(8);
  const info = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => file.readDoubleLE(12 + i * 8));
  if (width === 0 || height === 0 || stride < width * 4 || !Number.isSafeInteger(stride * height)) {
    throw new Error(`${path} has invalid pixel dimensions or row stride`);
  }
  const encoded = file.readUInt32LE(80);
  if (encoded === 0 || file.length !== HEAD + encoded) throw new Error(`${path} has an incomplete or extra compressed block`);
  const [x, y, w, h, contentScale, scale, requested, completed] = info;
  if (!Number.isFinite(requested) || !Number.isFinite(completed) || completed < requested) {
    throw new Error(`${path} has a still completed at ${completed}ms before it was requested at ${requested}ms`);
  }
  return { width, height, stride, content: { x, y, width: w, height: h }, contentScale, scale, requested, completed,
    checksum: file.readUInt32LE(84) };
}

/**
 * Whether two frame files hold the same pixels. The encoder of the recording is deterministic, so two stills with the same
 * pixels have the same compressed block: the files are compared by their size, their checksum and their compressed block,
 * without restoring the pixels.
 */
export function samePixels(pathA, pathB) {
  const a = readFileSync(pathA);
  const b = readFileSync(pathB);
  const headA = frameHead(pathA, a);
  const headB = frameHead(pathB, b);
  return headA.width === headB.width && headA.height === headB.height && headA.stride === headB.stride
    && headA.checksum === headB.checksum && a.subarray(HEAD).equals(b.subarray(HEAD));
}

/** The frames of one folder in the order of their stills. */
export function frames(directory) {
  // A frame is named by the four-digit index of its still in the recording (0 to 4095); a still that wrote no frame leaves a
  // gap in the names, which stills.jsonl explains (docs/spec/endpoint.md).
  const number = (name) => {
    const match = /^frame-(\d{4})\.bgra$/.exec(name);
    if (!match) throw new Error(`recording ${directory} has an unexpected frame file ${name}`);
    return Number(match[1]);
  };
  return readdirSync(directory)
    .filter((name) => name.endsWith(".bgra"))
    .map((name) => ({ name, index: number(name) }))
    .sort((a, b) => a.index - b.index)
    .map(({ name }) => join(directory, name));
}

/** The [r, g, b] of one pixel. */
export function pixel(frame, x, y) {
  const i = y * frame.stride + x * 4;
  return [frame.data[i + 2], frame.data[i + 1], frame.data[i]];
}

/**
 * The rectangle (points) and the number of the pixels that differ between two frames of one size, or null for equal frames.
 * A capture delivers a frame for any change in the window, so this states what a frame shows that the frame before it does not.
 */
export function frameChange(before, after) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`frameChange compares frames of one size, got frames of ${before.width}x${before.height} and ${after.width}x${after.height}`);
  }
  let left = Infinity, top = Infinity, right = -1, bottom = -1, pixels = 0;
  for (let y = 0; y < after.height; y++) {
    const start = y * before.stride, end = y * after.stride;
    if (before.data.compare(after.data, end, end + after.width * 4, start, start + before.width * 4) === 0) continue;
    for (let x = 0; x < after.width; x++) {
      const a = start + x * 4, b = end + x * 4;
      if (before.data[a] === after.data[b] && before.data[a + 1] === after.data[b + 1] && before.data[a + 2] === after.data[b + 2]) continue;
      pixels++;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = y;
    }
  }
  if (pixels === 0) return null;
  const scale = after.scale;
  return { x: left / scale, y: top / scale, width: (right - left + 1) / scale, height: (bottom - top + 1) / scale, pixels };
}

/** Measures reported and decoded capture intervals independently of functional proof. */
export function captureCadence(reported, times) {
  if (!Number.isFinite(reported) || reported < 0) throw new Error("capture reported frame gap is invalid");
  if (!Array.isArray(times) || times.length < 2 || !times.every(time => Number.isFinite(time) && time >= 0)) {
    throw new Error("capture requires at least two valid frame times");
  }
  const gaps = times.slice(1).map((time, index) => time - times[index]);
  if (gaps.some(gap => gap < 0)) throw new Error("capture frame times are not ordered");
  return { reported, measured: Math.max(...gaps), gaps };
}
