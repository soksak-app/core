import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";
import { echoed, terminalBackgroundSample } from "../terminal-screen.mjs";

function capturedFrame({ scale, contentScale, origin, point }) {
  const width = 64, height = 64, stride = width * 4 + 8;
  const data = Buffer.alloc(stride * height, 255);
  data.set([56, 34, 12, 255], point[1] * stride + point[0] * 4);
  // A literal-only LZ4 block keeps the fixture's declared capture pixels exact.
  const lengths = [0xf0];
  let remaining = data.length - 15;
  while (remaining >= 255) { lengths.push(255); remaining -= 255; }
  lengths.push(remaining);
  const block = Buffer.concat([Buffer.from(lengths), data]);
  const header = Buffer.alloc(80);
  header.writeUInt32LE(width, 0); header.writeUInt32LE(height, 4); header.writeUInt32LE(stride, 8);
  [...origin, width / scale - origin[0], height / scale - origin[1], contentScale, scale, 42].forEach((value, i) => header.writeDoubleLE(value, 12 + i * 8));
  header.write("LZ4B", 68); header.writeUInt32LE(block.length, 72); header.writeUInt32LE(crc32(data), 76);
  return Buffer.concat([header, block]);
}

function captureSession(directory) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push([method, params]);
      if (method === "diagnostics.capture.start") return {};
      assert.equal(method, "diagnostics.capture.stop");
      assert.deepEqual(params, { after: 42 });
      return { frames: directory };
    },
    async presented() { calls.push(["presented"]); return { displayed: 42 }; },
  };
}

for (const geometry of [
  { name: "terminal background samples the captured view at unit scale", scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11] },
  { name: "terminal background samples the captured view at display scale", scale: 2, contentScale: 1, origin: [0, 0], point: [20, 22] },
  { name: "terminal background samples the captured view at content scale", scale: 1, contentScale: 2, origin: [0, 0], point: [20, 22] },
  { name: "terminal background samples the captured view at content origin", scale: 1, contentScale: 1, origin: [16, 24], point: [26, 35] },
  { name: "terminal background samples the captured view at combined scale and origin", scale: 2, contentScale: 1.5, origin: [3, 5], point: [36, 43] },
  { name: "terminal background samples inside a one-pixel view", scale: 1, contentScale: 1, origin: [0, 0], point: [4, 8], rect: { x: 4, y: 8, width: 1, height: 1 } },
]) {
  test(geometry.name, { timeout: 5000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "terminal-background-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "frame-1.bgra"), capturedFrame(geometry));
    const session = captureSession(directory);
    const sample = await terminalBackgroundSample(session, geometry.rect ?? { x: 4, y: 8, width: 8, height: 4 });
    assert.deepEqual(sample, [12, 34, 56], "the sample must read the marked terminal pixel, not the white surrounding card");
    assert.deepEqual(session.calls, [["diagnostics.capture.start", {}], ["presented"], ["diagnostics.capture.stop", { after: 42 }]]);
    assert.equal(existsSync(directory), false, "the completed capture must be removed");
  });
}

test("terminal background rejects an empty capture and removes its folder", { timeout: 5000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-background-empty-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(terminalBackgroundSample(captureSession(directory), { x: 4, y: 8, width: 8, height: 4 }), /no frames/);
  assert.equal(existsSync(directory), false, "a failed sample must not leave its capture folder");
});

for (const invalid of [
  { name: "terminal background rejects a corrupt frame and removes its folder", bytes: Buffer.from("broken"), rect: { x: 4, y: 8, width: 8, height: 4 }, error: /complete LZ4 frame header/ },
  { name: "terminal background rejects an outside view and removes its folder", bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11] }), rect: { x: 60, y: 8, width: 8, height: 4 }, error: /outside/ },
]) {
  test(invalid.name, { timeout: 5000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "terminal-background-invalid-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "frame-1.bgra"), invalid.bytes);
    await assert.rejects(terminalBackgroundSample(captureSession(directory), invalid.rect), invalid.error);
    assert.equal(existsSync(directory), false, "a failed sample must not leave its capture folder");
  });
}

test("a command and its output are found when the terminal wrapped them and when it did not", () => {
  // 11 columns: the command and its output of 12 characters each take two rows.
  assert.equal(echoed(["sh-3.2$ ech", "o afterproj", "ect", "afterprojec", "t", "sh-3.2$"], "afterproject"), true);
  assert.equal(echoed(["sh-3.2$ echo afterproject", "afterproject", "sh-3.2$"], "afterproject"), true);
  // The command without its output, and an output of another command, are not found.
  assert.equal(echoed(["sh-3.2$ echo afterproject"], "afterproject"), false);
  assert.equal(echoed(["sh-3.2$ echo afterproject", "afterresize", "sh-3.2$"], "afterproject"), false);
});
