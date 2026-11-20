// The pixels of the frames of a recording (diagnostics.capture.start/stop, docs/spec/endpoint.md), for the layout redraw benchmark
// (e2e/benchmark/layout-redraw.test.mjs), which counts the frames in which an image region shows no pixel of its raster. A frame
// file frame-NNNN.bgra holds 88 header bytes, the width, height and row stride (u32), the content rectangle x, y, width and height,
// the content scale, the scale and the request and completion time of its still (f64, ms on the clock of diagnostics.clock), the
// marker LZ4S at byte 76, the length of the compressed block (u32) and the CRC-32 of the pixels (u32), and then one LZ4 raw block
// of the BGRA pixels. The stills are evidence that no check judges (docs/spec/diagnostics.md): the benchmark reports the counts and
// passes or fails on none of them.
//
// The LZ4 decoder is written here because the library does not meet its contract: lz4js 0.2.0 decompressBlock (lz4.js lines
// 204-258) accepts a truncated literal run, a zero or out-of-range match offset and a missing length extension without an error and
// does not compare its output with the declared size, so a cut-off frame would read as a frame of black pixels (F166.6).
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";

const HEAD = 88;
const MARKER = "LZ4S";

/** Restores an LZ4 raw block `source` to `expected` bytes; a truncated block, an invalid reference and another size are errors. */
export function decodeLz4(source, expected) {
  const data = Buffer.alloc(expected);
  let input = 0;
  let output = 0;
  let finished = false;
  const length = (base) => {
    if (base !== 15) return base;
    let next;
    do {
      if (input >= source.length) throw new Error("LZ4 length extension is incomplete");
      next = source[input++];
      base += next;
      if (base > expected) throw new Error("LZ4 length exceeds the declared pixel size");
    } while (next === 255);
    return base;
  };
  while (input < source.length) {
    const token = source[input++];
    const literals = length(token >>> 4);
    if (input + literals > source.length || output + literals > expected) throw new Error("LZ4 literals exceed the block or declared pixel size");
    source.copy(data, output, input, input + literals);
    input += literals;
    output += literals;
    if (input === source.length) {
      if (expected >= 5 && literals < 5) throw new Error("LZ4 final literals are incomplete");
      finished = true;
      break;
    }
    if (input + 2 > source.length) throw new Error("LZ4 match offset is incomplete");
    const offset = source.readUInt16LE(input);
    input += 2;
    if (offset === 0 || offset > output) throw new Error("LZ4 match references unavailable pixels");
    let count = length(token & 15) + 4;
    if (output > expected - 12 || output + count > expected) throw new Error("LZ4 match exceeds the declared pixel size");
    const from = output - offset;
    let available = offset;
    while (count > 0) {
      const copied = Math.min(available, count);
      data.copy(data, output, from, from + copied);
      output += copied;
      available += copied;
      count -= copied;
    }
  }
  if (!finished || output !== expected) throw new Error(`LZ4 restores ${output} bytes, ${expected} expected`);
  return data;
}

/**
 * Reads the frame file `path` as `{width, height, stride, content, contentScale, scale, requested, completed, data}`. A file
 * shorter than its header and block, another marker, invalid dimensions, a still that completed before its request and a checksum
 * that differs from the restored pixels are errors that name the file.
 */
export function readFrame(path) {
  const file = readFileSync(path);
  if (file.length < HEAD || !file.subarray(76, 80).equals(Buffer.from(MARKER))) throw new Error(`${path} has no complete ${MARKER} frame header of a still`);
  const width = file.readUInt32LE(0);
  const height = file.readUInt32LE(4);
  const stride = file.readUInt32LE(8);
  if (width === 0 || height === 0 || stride < width * 4 || !Number.isSafeInteger(stride * height)) throw new Error(`${path} has invalid pixel dimensions or row stride`);
  const [x, y, w, h, contentScale, scale, requested, completed] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => file.readDoubleLE(12 + i * 8));
  if (!Number.isFinite(requested) || !Number.isFinite(completed) || completed < requested) {
    throw new Error(`${path} has a still completed at ${completed}ms before it was requested at ${requested}ms`);
  }
  const encoded = file.readUInt32LE(80);
  if (encoded === 0 || file.length !== HEAD + encoded) throw new Error(`${path} has an incomplete or extra compressed block`);
  let data;
  try {
    data = decodeLz4(file.subarray(HEAD), stride * height);
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
  if (crc32(data) !== file.readUInt32LE(84)) throw new Error(`${path} has an invalid pixel checksum`);
  return { width, height, stride, content: { x, y, width: w, height: h }, contentScale, scale, requested, completed, data };
}

/**
 * The pixel of the frame at the window point `point` ({x, y} in window points): the content of the window starts at the content
 * origin of the frame, in points of its scale, and a window point is scale times content scale pixels. A point outside the frame is
 * an error.
 */
export function pixelAt(frame, point) {
  const x = Math.floor(frame.content.x * frame.scale + point.x * frame.scale * frame.contentScale);
  const y = Math.floor(frame.content.y * frame.scale + point.y * frame.scale * frame.contentScale);
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new Error(`the window point ${point.x},${point.y} is outside the frame of ${frame.width}x${frame.height} pixels`);
  const at = y * frame.stride + x * 4;
  return [frame.data[at + 2], frame.data[at + 1], frame.data[at]];
}

/**
 * The number of pixels of the frame whose red, green and blue are each within `tolerance` of each colour of `colours` ([r, g, b]),
 * as a list in the order of the colours. The frame holds the values that the window server composited in the colour space of the
 * display, so the colours are read from a frame (pixelAt), not converted from their declared values.
 */
export function colourCounts(frame, colours, tolerance) {
  const counts = colours.map(() => 0);
  const { data, stride, width, height } = frame;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const at = row + x * 4;
      const b = data[at];
      const g = data[at + 1];
      const r = data[at + 2];
      for (let i = 0; i < colours.length; i++) {
        const [cr, cg, cb] = colours[i];
        if (Math.abs(r - cr) <= tolerance && Math.abs(g - cg) <= tolerance && Math.abs(b - cb) <= tolerance) {
          counts[i]++;
          break;
        }
      }
    }
  }
  return counts;
}
