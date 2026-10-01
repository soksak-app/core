import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { frames, readFrame } from "../frame.mjs";

function fixture(block = Buffer.concat([Buffer.from([0xf0, 17]), Buffer.from(Array.from({ length: 32 }, (_, i) => i))])) {
  const header = Buffer.alloc(80);
  header.writeUInt32LE(3, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(16, 8);
  [4, 5, 3, 2, 1, 2, 123.5].forEach((value, i) => header.writeDoubleLE(value, 12 + i * 8));
  header.write("LZ4B", 68); header.writeUInt32LE(block.length, 72);
  header.writeUInt32LE(crc32(Buffer.from(Array.from({ length: 32 }, (_, i) => i))), 76);
  return Buffer.concat([header, block]);
}

function read(bytes) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-frame-contract-"));
  try { const path = join(directory, "frame-0001.bgra"); writeFileSync(path, bytes); return readFrame(path); }
  finally { rmSync(directory, { recursive: true }); }
}

test("frame reader restores lossless pixels, padding and unchanged metadata", () => {
  const frame = read(fixture());
  assert.equal(frame.width, 3); assert.equal(frame.height, 2); assert.equal(frame.stride, 16);
  assert.deepEqual(frame.content, { x: 4, y: 5, width: 3, height: 2 });
  assert.equal(frame.contentScale, 1); assert.equal(frame.scale, 2); assert.equal(frame.time, 123.5);
  assert.deepEqual(frame.data, Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
});

test("frame reader restores overlapping LZ4 matches", () => {
  const file = fixture(Buffer.from([0x1f, 0, 1, 0, 7, 0x50, 0, 0, 0, 0, 0]));
  file.writeUInt32LE(crc32(Buffer.alloc(32)), 76);
  assert.deepEqual(read(file).data, Buffer.alloc(32));
});

for (const [label, corrupt] of [
  ["retired raw format", (file) => Buffer.concat([file.subarray(0, 68), Buffer.alloc(32)])],
  ["truncated compressed block", (file) => file.subarray(0, file.length - 1)],
  ["extra compressed bytes", (file) => Buffer.concat([file, Buffer.from([0])])],
  ["wrong checksum", (file) => { file[76] ^= 1; return file; }],
  ["high-bit marker corruption", (file) => { file[68] |= 0x80; return file; }],
  ["zero dimensions", (file) => { file.writeUInt32LE(0, 0); return file; }],
  ["short row stride", (file) => { file.writeUInt32LE(11, 8); return file; }],
  ["short decoded output", (file) => { file.writeUInt32LE(3, 4); return file; }],
  ["zero match offset", () => fixture(Buffer.from([0x10, 1, 0, 0, 0x50, 0, 0, 0, 0, 0]))],
  ["match before output", () => fixture(Buffer.from([0x10, 1, 2, 0, 0x50, 0, 0, 0, 0, 0]))],
  ["missing length extension", () => fixture(Buffer.from([0xf0, 255]))],
]) test(`frame reader rejects ${label}`, () => assert.throws(() => read(corrupt(fixture()))));

test("frames are listed in frame number order after the number passes four digits", (t) => {
  // 한 process 의 녹화는 frame 번호를 이어서 매기므로 오래 실행한 뒤의 녹화는 9999 를 넘는다.
  const directory = mkdtempSync(join(tmpdir(), "soksak-frame-order-"));
  t.after(() => rmSync(directory, { recursive: true }));
  for (const number of [9998, 9999, 10000, 10001]) writeFileSync(join(directory, `frame-${String(number).padStart(4, "0")}.bgra`), "");
  writeFileSync(join(directory, "frame-10002.bgra.partial"), "");
  assert.deepEqual(frames(directory).map((path) => path.split("/").at(-1)),
    ["frame-9998.bgra", "frame-9999.bgra", "frame-10000.bgra", "frame-10001.bgra"]);
});
