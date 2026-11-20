// The frame reader of the layout redraw benchmark (e2e/benchmark/cases/frame-pixels.mjs): the LZ4 raw block, the header of a still and
// the colour counts that the benchmark reports.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";

import { colourCounts, decodeLz4, pixelAt, readFrame } from "../benchmark/cases/frame-pixels.mjs";

const PIXELS = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

// A frame of a still recording: three uint32 sizes, eight float64 (content x, y, width, height, content scale, scale, the request
// and the completion time of its still), the marker LZ4S, the size of the compressed block and the checksum.
function fixture(block = Buffer.concat([Buffer.from([0xf0, 17]), PIXELS]), pixels = PIXELS) {
  const header = Buffer.alloc(88);
  header.writeUInt32LE(3, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(16, 8);
  [4, 5, 3, 2, 1, 2, 123.5, 124.25].forEach((value, i) => header.writeDoubleLE(value, 12 + i * 8));
  header.write("LZ4S", 76); header.writeUInt32LE(block.length, 80); header.writeUInt32LE(crc32(pixels), 84);
  return Buffer.concat([header, block]);
}

function read(bytes) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-frame-pixels-"));
  try {
    const path = join(directory, "frame-0001.bgra");
    writeFileSync(path, bytes);
    return readFrame(path);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("the frame reader restores the pixels, the padding and the header of a still", { timeout: 5000 }, () => {
  const frame = read(fixture());
  assert.deepEqual([frame.width, frame.height, frame.stride], [3, 2, 16]);
  assert.deepEqual(frame.content, { x: 4, y: 5, width: 3, height: 2 });
  assert.deepEqual([frame.contentScale, frame.scale, frame.requested, frame.completed], [1, 2, 123.5, 124.25]);
  assert.deepEqual(frame.data, PIXELS);
});

test("the frame reader restores overlapping LZ4 matches", { timeout: 5000 }, () => {
  assert.deepEqual(read(fixture(Buffer.from([0x1f, 0, 1, 0, 7, 0x50, 0, 0, 0, 0, 0]), Buffer.alloc(32))).data, Buffer.alloc(32));
});

for (const [label, corrupt] of [
  ["a frame without the marker LZ4S", (file) => { file.write("LZ4B", 76); return file; }],
  ["a still completed before its request", (file) => { file.writeDoubleLE(123, 12 + 7 * 8); return file; }],
  ["a truncated compressed block", (file) => file.subarray(0, file.length - 1)],
  ["extra compressed bytes", (file) => Buffer.concat([file, Buffer.from([0])])],
  ["a wrong checksum", (file) => { file[84] ^= 1; return file; }],
  ["zero dimensions", (file) => { file.writeUInt32LE(0, 0); return file; }],
  ["a short row stride", (file) => { file.writeUInt32LE(11, 8); return file; }],
  ["a short decoded output", (file) => { file.writeUInt32LE(3, 4); return file; }],
  ["a zero match offset", () => fixture(Buffer.from([0x10, 1, 0, 0, 0x50, 0, 0, 0, 0, 0]))],
  ["a match before the output", () => fixture(Buffer.from([0x10, 1, 2, 0, 0x50, 0, 0, 0, 0, 0]))],
  ["a missing length extension", () => fixture(Buffer.from([0xf0, 255]))],
]) test(`the frame reader rejects ${label}`, { timeout: 5000 }, () => assert.throws(() => read(corrupt(fixture()))));

test("the LZ4 decoder rejects a block that restores fewer bytes than declared", { timeout: 5000 }, () => {
  assert.throws(() => decodeLz4(Buffer.concat([Buffer.from([0x50]), Buffer.alloc(5)]), 6), /restores 5 bytes, 6 expected/);
});

/** A frame of `width` by `height` pixels at the scale 2 whose content starts at {1, 0} points, filled with the BGRA of `fill`. */
const solid = (width, height, fill) => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([fill[2], fill[1], fill[0], 255], i * 4);
  return { width, height, stride: width * 4, content: { x: 1, y: 0, width: width / 2 - 1, height: height / 2 }, contentScale: 1, scale: 2, data };
};

test("a window point reads the pixel of the content origin and the scale, and a point outside the frame is refused", { timeout: 5000 }, () => {
  const frame = solid(8, 4, [10, 20, 30]);
  frame.data.set([3, 2, 1, 255], (1 * 8 + 4) * 4);
  assert.deepEqual(pixelAt(frame, { x: 1, y: 0.5 }), [1, 2, 3], "the point 1,0.5 is the pixel 2+2, 1");
  assert.deepEqual(pixelAt(frame, { x: 0, y: 0 }), [10, 20, 30]);
  assert.throws(() => pixelAt(frame, { x: 3, y: 0 }), /outside the frame of 8x4 pixels/);
});

test("the colour counts hold the pixels within the tolerance of each colour, each pixel counted once", { timeout: 5000 }, () => {
  const frame = solid(4, 2, [100, 100, 100]);
  frame.data.set([0, 0, 200, 255], 0);
  frame.data.set([0, 0, 203, 255], 4);
  frame.data.set([0, 0, 204, 255], 8);
  assert.deepEqual(colourCounts(frame, [[200, 0, 0], [100, 100, 100], [99, 99, 99]], 3), [2, 5, 0]);
});
