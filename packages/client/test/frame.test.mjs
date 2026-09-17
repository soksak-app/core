import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameReader, MAX_FRAME_LENGTH } from "../frame.js";

const request = { jsonrpc: "2.0", id: 1, method: "status.get", params: { name: "core.screen" } };

test("encodeFrame writes big-endian length prefix", () => {
  const frame = encodeFrame(request);
  const body = Buffer.from(JSON.stringify(request), "utf8");
  assert.equal(frame.readUInt32BE(0), body.length);
  assert.deepEqual(frame.subarray(4), body);
});

test("frames split at every byte boundary are reassembled", () => {
  const frame = Buffer.concat([encodeFrame(request), encodeFrame({ ...request, id: 2, params: { name: "화면" } })]);
  for (let cut = 0; cut <= frame.length; cut += 1) {
    const reader = new FrameReader();
    const out = [...reader.push(frame.subarray(0, cut)), ...reader.push(frame.subarray(cut))];
    assert.deepEqual(out.map((m) => m.id), [1, 2], `cut at ${cut}`);
    assert.equal(out[1].params.name, "화면");
    assert.equal(reader.pending, 0);
  }
});

test("single-byte chunks are reassembled", () => {
  const frame = encodeFrame(request);
  const reader = new FrameReader();
  const out = [];
  for (const byte of frame) out.push(...reader.push(Buffer.from([byte])));
  assert.deepEqual(out, [request]);
});

test("multiple frames in one chunk are all returned", () => {
  const chunk = Buffer.concat([1, 2, 3].map((id) => encodeFrame({ ...request, id })));
  const reader = new FrameReader();
  assert.deepEqual([...reader.push(chunk)].map((m) => m.id), [1, 2, 3]);
});

test("length above 16 MiB is rejected from the header alone", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_LENGTH + 1, 0);
  const reader = new FrameReader();
  assert.throws(() => [...reader.push(header)], RangeError);
});

test("length of exactly 16 MiB is accepted while waiting for the body", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_LENGTH, 0);
  const reader = new FrameReader();
  assert.deepEqual([...reader.push(header)], []);
});

test("invalid JSON is rejected", () => {
  const body = Buffer.from("{not json", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  const reader = new FrameReader();
  assert.throws(() => [...reader.push(Buffer.concat([header, body]))], SyntaxError);
});
