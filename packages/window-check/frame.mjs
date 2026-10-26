// Reads one frame that a capture recorded.
//
// A frame restores all BGRA bytes from an LZ4 block with metadata and a checksum.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { decodeLz4 } from "./lz4.mjs";

const HEAD = 80;

/**
 * Reads one file as { width, height, stride, content, contentScale, scale, time, data }. content is the rectangle in
 * the buffer where the window is drawn (buffer points), and time is the display time (ms).
 *
 * Rejects a short file. A frame that was being written while the recording stopped is cut off, and reading a cut-off
 * position gives undefined, which no color check catches. Left as it is, a broken frame would be treated as a whole
 * frame.
 */
export function readFrame(path) {
  const file = readFileSync(path);
  if (file.length < HEAD || !file.subarray(68, 72).equals(Buffer.from("LZ4B"))) {
    throw new Error(`${path} has no complete LZ4 frame header`);
  }
  const width = file.readUInt32LE(0);
  const height = file.readUInt32LE(4);
  const stride = file.readUInt32LE(8);
  const info = [0, 1, 2, 3, 4, 5, 6].map((i) => file.readDoubleLE(12 + i * 8));
  if (width === 0 || height === 0 || stride < width * 4 || !Number.isSafeInteger(stride * height)) {
    throw new Error(`${path} has invalid pixel dimensions or row stride`);
  }
  const encoded = file.readUInt32LE(72);
  if (encoded === 0 || file.length !== HEAD + encoded) throw new Error(`${path} has an incomplete or extra compressed block`);
  const data = decodeLz4(file.subarray(HEAD), stride * height);
  if (crc32(data) !== file.readUInt32LE(76)) throw new Error(`${path} has an invalid pixel checksum`);
  const [x, y, w, h, contentScale, scale, time] = info;
  return { width, height, stride, content: { x, y, width: w, height: h }, contentScale, scale, time, data };
}

/** The frames of one folder in the written order. */
export function frames(directory) {
  // The recording of one process continues the frame numbers, so after the number passes 9999 the string order of the
  // names differs from the frame order. The frames are sorted by the number in the name (docs/spec/endpoint.md).
  const number = (name) => {
    const match = /^frame-(\d+)\.bgra$/.exec(name);
    if (!match) throw new Error(`recording ${directory} has an unexpected frame file ${name}`);
    return Number(match[1]);
  };
  return readdirSync(directory)
    .filter((name) => name.endsWith(".bgra"))
    .sort((a, b) => number(a) - number(b))
    .map((name) => join(directory, name));
}

/** The [r, g, b] of one pixel. */
export function pixel(frame, x, y) {
  const i = y * frame.stride + x * 4;
  return [frame.data[i + 2], frame.data[i + 1], frame.data[i]];
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
