import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { captureCadence, frameChange, frames, readFrame } from "../frame.mjs";

// A frame of a still recording: three uint32 sizes, eight float64 (content x, y, width, height, content scale, scale, the
// request and the completion time of its still), the marker LZ4S, the size of the compressed block and the checksum.
function fixture(block = Buffer.concat([Buffer.from([0xf0, 17]), Buffer.from(Array.from({ length: 32 }, (_, i) => i))])) {
  const header = Buffer.alloc(88);
  header.writeUInt32LE(3, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(16, 8);
  [4, 5, 3, 2, 1, 2, 123.5, 124.25].forEach((value, i) => header.writeDoubleLE(value, 12 + i * 8));
  header.write("LZ4S", 76); header.writeUInt32LE(block.length, 80);
  header.writeUInt32LE(crc32(Buffer.from(Array.from({ length: 32 }, (_, i) => i))), 84);
  return Buffer.concat([header, block]);
}

// The frame of a stream recording that the still recording replaced: seven float64 ending with a display time, marker LZ4B.
function streamFrame() {
  const pixels = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const block = Buffer.concat([Buffer.from([0xf0, 17]), pixels]);
  const header = Buffer.alloc(80);
  header.writeUInt32LE(3, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(16, 8);
  [4, 5, 3, 2, 1, 2, 123.5].forEach((value, i) => header.writeDoubleLE(value, 12 + i * 8));
  header.write("LZ4B", 68); header.writeUInt32LE(block.length, 72); header.writeUInt32LE(crc32(pixels), 76);
  return Buffer.concat([header, block]);
}

function read(bytes) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-frame-contract-"));
  try { const path = join(directory, "frame-0001.bgra"); writeFileSync(path, bytes); return readFrame(path); }
  finally { rmSync(directory, { recursive: true }); }
}

test("frame reader restores lossless pixels, padding, metadata and the request and completion time of the still", () => {
  const frame = read(fixture());
  assert.equal(frame.width, 3); assert.equal(frame.height, 2); assert.equal(frame.stride, 16);
  assert.deepEqual(frame.content, { x: 4, y: 5, width: 3, height: 2 });
  assert.equal(frame.contentScale, 1); assert.equal(frame.scale, 2);
  assert.equal(frame.requested, 123.5); assert.equal(frame.completed, 124.25);
  assert.equal("time" in frame, false, "a still has no single display time");
  assert.deepEqual(frame.data, Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
});

test("frame reader rejects a frame of the stream recording", () => {
  assert.throws(() => read(streamFrame()), /LZ4S/);
});

test("frame reader rejects a still that completed before its request", () => {
  const file = fixture();
  file.writeDoubleLE(123, 12 + 7 * 8);
  assert.throws(() => read(file), /completed .* before .* requested/);
});

test("frame reader restores overlapping LZ4 matches", () => {
  const file = fixture(Buffer.from([0x1f, 0, 1, 0, 7, 0x50, 0, 0, 0, 0, 0]));
  file.writeUInt32LE(crc32(Buffer.alloc(32)), 84);
  assert.deepEqual(read(file).data, Buffer.alloc(32));
});

for (const [label, corrupt] of [
  ["retired raw format", (file) => Buffer.concat([file.subarray(0, 76), Buffer.alloc(32)])],
  ["truncated compressed block", (file) => file.subarray(0, file.length - 1)],
  ["extra compressed bytes", (file) => Buffer.concat([file, Buffer.from([0])])],
  ["wrong checksum", (file) => { file[84] ^= 1; return file; }],
  ["high-bit marker corruption", (file) => { file[76] |= 0x80; return file; }],
  ["zero dimensions", (file) => { file.writeUInt32LE(0, 0); return file; }],
  ["short row stride", (file) => { file.writeUInt32LE(11, 8); return file; }],
  ["short decoded output", (file) => { file.writeUInt32LE(3, 4); return file; }],
  ["zero match offset", () => fixture(Buffer.from([0x10, 1, 0, 0, 0x50, 0, 0, 0, 0, 0]))],
  ["match before output", () => fixture(Buffer.from([0x10, 1, 2, 0, 0x50, 0, 0, 0, 0, 0]))],
  ["missing length extension", () => fixture(Buffer.from([0xf0, 255]))],
]) test(`frame reader rejects ${label}`, () => assert.throws(() => read(corrupt(fixture()))));

test("frames are listed in the order of their stills, with the stills that wrote no frame left out", (t) => {
  // A frame is named by the index of its still in the recording; a failed or not requested still leaves a gap in the names.
  const directory = mkdtempSync(join(tmpdir(), "soksak-frame-order-"));
  t.after(() => rmSync(directory, { recursive: true }));
  for (const index of [0, 1, 3, 10, 4095]) writeFileSync(join(directory, `frame-${String(index).padStart(4, "0")}.bgra`), "");
  writeFileSync(join(directory, "frame-0004.bgra.partial"), "");
  assert.deepEqual(frames(directory).map((path) => path.split("/").at(-1)),
    ["frame-0000.bgra", "frame-0001.bgra", "frame-0003.bgra", "frame-0010.bgra", "frame-4095.bgra"]);
});

test("frames refuse a name that is not the four digits of a still index", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "soksak-frame-name-"));
  t.after(() => rmSync(directory, { recursive: true }));
  writeFileSync(join(directory, "frame-10000.bgra"), "");
  assert.throws(() => frames(directory), /frame-10000\.bgra/);
});

test("complete capture cadence over 33 ms remains a measurement", { timeout: 5000 }, () => {
  assert.deepEqual(captureCadence(34, [100, 134, 167]), { reported: 34, measured: 34, gaps: [34, 33] });
});

test("capture cadence rejects missing or invalid timing evidence", { timeout: 5000 }, () => {
  for (const [reported, times] of [[NaN, [1, 2]], [-1, [1, 2]], [1, [1]], [1, [2, 1]], [1, [1, Infinity]]]) {
    assert.throws(() => captureCadence(reported, times), /capture.*(time|gap|interval|frame)/);
  }
});

test("frame change states the rectangle of the pixels that differ between two frames", () => {
  const frame = (changes = []) => {
    const data = Buffer.alloc(4 * 16);
    for (const [x, y] of changes) data[y * 16 + x * 4 + 1] = 9;
    return { width: 3, height: 4, stride: 16, scale: 2, data };
  };
  assert.equal(frameChange(frame(), frame()), null);
  assert.deepEqual(frameChange(frame(), frame([[1, 1], [2, 3]])), { x: 0.5, y: 0.5, width: 1, height: 1.5, pixels: 2 });
  assert.throws(() => frameChange(frame(), { ...frame(), width: 2 }), /frames of 3x4 and 2x4/);
});
