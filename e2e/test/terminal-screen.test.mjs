import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";
import { finishSession, Session } from "@soksak/window-check/app.mjs";
import { cellBackgrounds, echoed, terminalBackgroundSample } from "../terminal-screen.mjs";

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

function captureSession(t, { bytes, presentationError, stopError, viewError } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "terminal-background-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const frameDir = join(directory, "logs", "captures", "sample");
  mkdirSync(frameDir, { recursive: true });
  const log = join(directory, "logs", "host-1-1.jsonl");
  writeFileSync(log, `${JSON.stringify({ ts_us: 1791000000000000, seq: 1, level: "info", layer: "host",
    event: "log.open", fields: { schema: 2 } })}\n`);
  if (bytes) writeFileSync(join(frameDir, "frame-1.bgra"), bytes);
  const calls = [];
  const session = new Session({ name: "terminal-background", configDir: directory }, {
    endpoint: { pid: process.pid },
    async request(method, { window, ...params }) {
      assert.equal(window, "main");
      calls.push([method, params]);
      if (method === "diagnostics.capture.start") return { frames: frameDir };
      if (method === "command.run") {
        if (params.name === "terminal.screen.read") return { frame: { generation: 1, raster: 2, sequence: 3 } };
        assert.equal(params.name, "host.window.presented");
        if (presentationError) throw presentationError;
        return { displayed: 42 };
      }
      if (method === "dom.rect") {
        assert.equal(params.name, "terminal.view");
        if (viewError) throw viewError;
        return { document: { x: 0, y: 0 }, x: 4, y: 8 };
      }
      if (method === "status.get") {
        assert.equal(params.name, "terminal.session");
        return { cellWidth: 8, cellHeight: 4 };
      }
      assert.equal(method, "diagnostics.capture.stop");
      if (stopError) throw stopError;
      const callbackStatus = join(frameDir, "callback-status.jsonl");
      writeFileSync(callbackStatus, '{"sequence":1,"status":0,"displayTime":"42"}\n');
      return { frames: frameDir, callbackStatus };
    },
  });
  session.step = () => {};
  session.markTest = async () => null;
  session.eventStart = {};
  session.eventBoot = 0;
  session.until = async (name, predicate) => {
    assert.equal(name, "host.window");
    const state = { regions: [{ surface: "fixture-terminal", name: "view",
      presented: { generation: 1, raster: 2, sequence: 3 } }] };
    assert.ok(predicate(state), "the requested terminal frame must already be presented");
    return state;
  };
  const diagnostics = [];
  let closed = false;
  return {
    session, calls, frameDir, log, diagnostics,
    get closed() { return closed; },
    finish: (passed) => finishSession({ name: "terminal background", passed,
      diagnostic: (line) => diagnostics.push(line) }, session, () => { closed = true; }),
  };
}

const stops = ({ calls }) => calls.filter(([method]) => method === "diagnostics.capture.stop");
const rect = { x: 4, y: 8, width: 8, height: 4 };

for (const geometry of [
  { name: "terminal background samples the captured view at unit scale", scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11] },
  { name: "terminal background samples the captured view at display scale", scale: 2, contentScale: 1, origin: [0, 0], point: [20, 22] },
  { name: "terminal background samples the captured view at content scale", scale: 1, contentScale: 2, origin: [0, 0], point: [20, 22] },
  { name: "terminal background samples the captured view at content origin", scale: 1, contentScale: 1, origin: [16, 24], point: [26, 35] },
  { name: "terminal background samples the captured view at combined scale and origin", scale: 2, contentScale: 1.5, origin: [3, 5], point: [36, 43] },
  { name: "terminal background samples inside a one-pixel view", scale: 1, contentScale: 1, origin: [0, 0], point: [4, 8], rect: { x: 4, y: 8, width: 1, height: 1 } },
]) {
  test(geometry.name, { timeout: 5000 }, async (t) => {
    const capture = captureSession(t, { bytes: capturedFrame(geometry) });
    const sample = await terminalBackgroundSample(capture.session, geometry.rect ?? rect);
    assert.deepEqual(sample, [12, 34, 56], "the sample must read the marked terminal pixel, not the white surrounding card");
    assert.deepEqual(capture.calls, [["diagnostics.capture.start", {}],
      ["command.run", { name: "host.window.presented", params: {} }], ["diagnostics.capture.stop", { after: 42 }]]);
    assert.equal(existsSync(capture.frameDir), true, "the completed capture must remain until session finalization");
    await capture.finish(true);
    assert.equal(stops(capture).length, 1, "finalization must not repeat the stop");
    assert.equal(existsSync(capture.frameDir), false, "successful finalization must remove the capture");
    assert.equal(capture.closed, true);
  });
}

test("terminal background rejects an empty capture and preserves its folder", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t);
  await assert.rejects(terminalBackgroundSample(capture.session, rect), /no frames/);
  await capture.finish(false);
  assert.equal(stops(capture).length, 1);
  assert.equal(existsSync(capture.frameDir), true, "a failed sample must retain its capture evidence");
  assert.equal(capture.closed, true);
});

for (const invalid of [
  { name: "terminal background rejects a corrupt frame and preserves its folder", bytes: Buffer.from("broken"), rect, error: /complete LZ4 frame header/ },
  { name: "terminal background rejects an outside view and preserves its folder", bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11] }), rect: { x: 60, y: 8, width: 8, height: 4 }, error: /outside/ },
]) {
  test(invalid.name, { timeout: 5000 }, async (t) => {
    const capture = captureSession(t, invalid);
    await assert.rejects(terminalBackgroundSample(capture.session, invalid.rect), invalid.error);
    await capture.finish(false);
    assert.equal(stops(capture).length, 1);
    assert.equal(existsSync(capture.frameDir), true, "a failed sample must retain its capture evidence");
    assert.equal(capture.closed, true);
  });
}

test("terminal background presentation failure stops during cleanup and preserves its original error", { timeout: 5000 }, async (t) => {
  const presentationError = new Error("presentation failed");
  const capture = captureSession(t, { presentationError });
  await assert.rejects(terminalBackgroundSample(capture.session, rect), (error) => error === presentationError);
  assert.equal(stops(capture).length, 0);
  await capture.finish(false);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 0 }]]);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

test("terminal background stop failure remains failed after being caught and is not retried", { timeout: 5000 }, async (t) => {
  const stopError = new Error("capture stop failed");
  const capture = captureSession(t, { stopError });
  await assert.rejects(terminalBackgroundSample(capture.session, rect), (error) => error === stopError);
  await assert.rejects(capture.finish(true), /1 recording failed: .*capture stop failed/);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 42 }]]);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

test("terminal background keeps the presentation error and reports a cleanup stop error", { timeout: 5000 }, async (t) => {
  const presentationError = new Error("presentation failed");
  const stopError = new Error("capture cleanup failed");
  const capture = captureSession(t, { presentationError, stopError });
  let cleaned = false;
  capture.session.cleanup(() => { cleaned = true; });
  await assert.rejects(terminalBackgroundSample(capture.session, rect), (error) => error === presentationError);
  await assert.rejects(capture.finish(false), (error) => error === stopError);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 0 }]]);
  assert.ok(capture.diagnostics.some((line) => /cleanup failed: Error: capture cleanup failed/.test(line)));
  assert.equal(cleaned, true, "the remaining session cleanup must run after stop fails");
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

test("terminal background preserves a successful sample when the final error audit fails", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11] }) });
  assert.deepEqual(await terminalBackgroundSample(capture.session, rect), [12, 34, 56]);
  appendFileSync(capture.log, `${JSON.stringify({ ts_us: 1791000000000001, seq: 2, level: "error", layer: "host",
    event: "host.test.failed", fields: {} })}\n`);
  await assert.rejects(capture.finish(true), /application logged 1 error/);
  assert.equal(existsSync(capture.frameDir), true, "a later audit failure must retain the sampled capture");
  assert.equal(stops(capture).length, 1);
  assert.equal(capture.closed, true);
});

test("terminal cell backgrounds retain their sample until successful session finalization", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [5, 8] }) });
  assert.deepEqual(await cellBackgrounds(capture.session, "fixture-terminal", [{ col: 0, row: 0 }]), [[12, 34, 56]]);
  assert.equal(existsSync(capture.frameDir), true, "cell capture must remain until finalization");
  await capture.finish(true);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 42 }]]);
  assert.equal(existsSync(capture.frameDir), false);
  assert.equal(capture.closed, true);
});

test("terminal cell presentation failure stops during cleanup and retains its evidence", { timeout: 5000 }, async (t) => {
  const presentationError = new Error("cell presentation failed");
  const capture = captureSession(t, { presentationError });
  await assert.rejects(cellBackgrounds(capture.session, "fixture-terminal", [{ col: 0, row: 0 }]),
    (error) => error === presentationError);
  await capture.finish(false);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 0 }]]);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

test("terminal cell stop failure remains failed after being caught and is not retried", { timeout: 5000 }, async (t) => {
  const stopError = new Error("cell capture stop failed");
  const capture = captureSession(t, { stopError });
  await assert.rejects(cellBackgrounds(capture.session, "fixture-terminal", [{ col: 0, row: 0 }]),
    (error) => error === stopError);
  await assert.rejects(capture.finish(true), /1 recording failed: .*cell capture stop failed/);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 42 }]]);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

for (const invalid of [
  { name: "terminal cell backgrounds preserve an empty capture", error: /no frames/ },
  { name: "terminal cell backgrounds preserve a corrupt capture", bytes: Buffer.from("broken"), error: /complete LZ4 frame header/ },
  { name: "terminal cell backgrounds preserve a capture when the view read fails",
    bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [5, 8] }),
    viewError: new Error("cell view read failed"), error: /cell view read failed/ },
]) {
  test(invalid.name, { timeout: 5000 }, async (t) => {
    const capture = captureSession(t, invalid);
    await assert.rejects(cellBackgrounds(capture.session, "fixture-terminal", [{ col: 0, row: 0 }]), invalid.error);
    await capture.finish(false);
    assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 42 }]]);
    assert.equal(existsSync(capture.frameDir), true);
    assert.equal(capture.closed, true);
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
