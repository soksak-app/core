import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";
import { finishSession, Session } from "@soksak/window-check/app.mjs";
import { regionCells, regionSample, RASTER_ELEMENT } from "../region-sample.mjs";
import { writeStillRecording } from "@soksak/window-check/still-recording.mjs";

// The recording of a sample takes a still every 8ms (a display of 125 Hz): the stills 0 to 6, requested at 0 to 48ms, were taken
// before the stop, the last one after the presentation at 42ms, and the rest of the 4096 planned stills were not requested.
const GAP = 8;
const TAKEN = 7;

/** A still requested at `requested` (ms, by default that of still `TAKEN - 1`) and completed 0.5ms later, with marked pixels. */
function capturedFrame({ scale, contentScale, origin, point, marks = [{ point, color: [12, 34, 56] }],
  requested = (TAKEN - 1) * GAP }) {
  const width = 64, height = 64, stride = width * 4 + 8;
  const data = Buffer.alloc(stride * height, 255);
  for (const { point: [x, y], color: [red, green, blue] } of marks) data.set([blue, green, red, 255], y * stride + x * 4);
  // A literal-only LZ4 block keeps the fixture's declared capture pixels exact.
  const lengths = [0xf0];
  let remaining = data.length - 15;
  while (remaining >= 255) { lengths.push(255); remaining -= 255; }
  lengths.push(remaining);
  const block = Buffer.concat([Buffer.from(lengths), data]);
  const header = Buffer.alloc(88);
  header.writeUInt32LE(width, 0); header.writeUInt32LE(height, 4); header.writeUInt32LE(stride, 8);
  [...origin, width / scale - origin[0], height / scale - origin[1], contentScale, scale, requested, requested + 0.5]
    .forEach((value, i) => header.writeDoubleLE(value, 12 + i * 8));
  header.write("LZ4S", 76); header.writeUInt32LE(block.length, 80); header.writeUInt32LE(crc32(data), 84);
  return Buffer.concat([header, block]);
}

/**
 * A session whose recording writes `bytes` as its last still. With `empty` every still of the recording failed. `taken` is the
 * number of stills requested before the stop.
 */
function captureSession(t, { bytes, empty = false, presentationError, stopError, viewError, taken = TAKEN,
  view = { document: { x: 0, y: 0 }, x: 4, y: 8 }, cellWidth = 8, cellHeight = 4, frameScale = 1 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "region-sample-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const frameDir = join(directory, "logs", "captures", "sample");
  mkdirSync(frameDir, { recursive: true });
  const log = join(directory, "logs", "host-1-1.jsonl");
  writeFileSync(log, `${JSON.stringify({ ts_us: 1791000000000000, seq: 1, level: "info", layer: "host",
    event: "log.open", fields: { schema: 2 } })}\n`);
  const calls = [];
  const session = new Session({ name: "region-sample", configDir: directory }, {
    endpoint: { pid: process.pid },
    async request(method, { window, ...params }) {
      assert.equal(window, "main");
      calls.push([method, params]);
      // A recording holds the covered drawing of the window until it stops (holdCovered of the session).
      if (method === "diagnostics.window.draw-covered") return null;
      if (method === "status.get") return { refreshRate: 1000 / GAP };
      if (method === "diagnostics.capture.start") return { frames: frameDir };
      if (method === "command.run") {
        assert.equal(params.name, "host.window.presented");
        if (presentationError) throw presentationError;
        return { displayed: 42 };
      }
      if (method === "element.rect") {
        assert.deepEqual(params, { name: RASTER_ELEMENT, surface: "fixture-probe" });
        if (viewError) throw viewError;
        return view;
      }
      assert.equal(method, "diagnostics.capture.stop");
      if (stopError) throw stopError;
      const failed = empty ? Array.from({ length: taken }, (_, index) => index) : [];
      const reply = writeStillRecording(frameDir, { gap: GAP, until: 4095 * GAP, stoppedAt: taken, failed });
      if (bytes) writeFileSync(join(frameDir, `frame-${String(taken - 1).padStart(4, "0")}.bgra`), bytes);
      return reply;
    },
  });
  session.step = () => {};
  session.markTest = async () => null;
  session.eventStart = {};
  session.eventBoot = 0;
  session.until = async (name, predicate, message, options) => {
    if (name === "rasterprobe.frame") {
      assert.deepEqual(options, { surface: "fixture-probe" });
      assert.equal(predicate(null), false, "a probe without a frame names no frame to wait for");
      const frame = { generation: 1, raster: 2, sequence: 3, scale: frameScale, grid: { cellWidth, cellHeight } };
      assert.ok(predicate(frame));
      return frame;
    }
    assert.equal(name, "host.window");
    const state = { regions: [{ surface: "fixture-probe", name: "raster",
      presented: { generation: 1, raster: 2, sequence: 3 } }] };
    assert.ok(predicate(state), "the requested probe frame must already be presented");
    for (const other of [{ generation: 1, raster: 2, sequence: 2 }, { generation: 2, raster: 2, sequence: 3 }, { generation: 1, raster: 3, sequence: 3 }]) {
      assert.equal(predicate({ regions: [{ surface: "fixture-probe", name: "raster", presented: other }] }), false,
        `a region that presented ${JSON.stringify(other)} has not presented the probe frame`);
    }
    for (const region of [{ surface: "other", name: "raster" }, { surface: "fixture-probe", name: "view" }]) {
      assert.equal(predicate({ regions: [{ ...region, presented: { generation: 1, raster: 2, sequence: 3 } }] }), false,
        `the region ${JSON.stringify(region)} is not the image region of the probe`);
    }
    return state;
  };
  const diagnostics = [];
  let closed = false;
  return {
    session, calls, frameDir, log, diagnostics,
    get closed() { return closed; },
    finish: (passed) => finishSession({ name: "region sample", passed,
      diagnostic: (line) => diagnostics.push(line) }, session, () => { closed = true; }),
  };
}

const stops = ({ calls }) => calls.filter(([method]) => method === "diagnostics.capture.stop");
const rect = { x: 4, y: 8, width: 8, height: 4 };

for (const geometry of [
  { name: "region sample reads the captured view at unit scale", scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11] },
  { name: "region sample reads the captured view at display scale", scale: 2, contentScale: 1, origin: [0, 0], point: [20, 22] },
  { name: "region sample reads the captured view at content scale", scale: 1, contentScale: 2, origin: [0, 0], point: [20, 22] },
  { name: "region sample reads the captured view at content origin", scale: 1, contentScale: 1, origin: [16, 24], point: [26, 35] },
  { name: "region sample reads the captured view at combined scale and origin", scale: 2, contentScale: 1.5, origin: [3, 5], point: [36, 43] },
  { name: "region sample reads inside a one-pixel view", scale: 1, contentScale: 1, origin: [0, 0], point: [4, 8], rect: { x: 4, y: 8, width: 1, height: 1 } },
]) {
  test(geometry.name, { timeout: 5000 }, async (t) => {
    const capture = captureSession(t, { bytes: capturedFrame(geometry) });
    const sample = await regionSample(capture.session, geometry.rect ?? rect);
    assert.deepEqual(sample, [12, 34, 56], "the sample must read the marked region pixel, not the white surrounding card");
    assert.deepEqual(capture.calls, [["status.get", { name: "host.window" }], ["diagnostics.window.draw-covered", { draw: true }],
      ["diagnostics.capture.start", { gap: GAP, frames: 4096 }],
      ["command.run", { name: "host.window.presented", params: {} }], ["diagnostics.capture.stop", { after: 42 }],
      ["diagnostics.window.draw-covered", { draw: false }]]);
    assert.equal(existsSync(capture.frameDir), true, "the completed capture must remain until session finalization");
    await capture.finish(true);
    assert.equal(stops(capture).length, 1, "finalization must not repeat the stop");
    assert.equal(existsSync(capture.frameDir), false, "successful finalization must remove the capture");
    assert.equal(capture.closed, true);
  });
}

// A still shows the window at a moment after its request, so only a still requested at or after the presentation shows it.
test("region sample rejects a recording whose last still was requested before the presentation", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { taken: TAKEN - 1,
    bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11], requested: (TAKEN - 2) * GAP }) });
  await assert.rejects(regionSample(capture.session, rect), /no still of the region capture was requested at or after the presentation at 42ms/);
  await capture.finish(false);
  assert.equal(existsSync(capture.frameDir), true, "a failed sample must retain its capture evidence");
});

// A capture whose every still failed lost them: the sample names each of them.
test("region sample rejects an empty capture and preserves its folder", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { empty: true });
  await assert.rejects(regionSample(capture.session, rect),
    /^Error: the recording lost 7 stills of the region capture: still 0 planned at 0\.0ms failed \(the window server returned no image\), /);
  await capture.finish(false);
  assert.equal(stops(capture).length, 1);
  assert.equal(existsSync(capture.frameDir), true, "a failed sample must retain its capture evidence");
  assert.equal(capture.closed, true);
});

for (const invalid of [
  { name: "region sample rejects a corrupt frame and preserves its folder", bytes: Buffer.from("broken"), rect, error: /complete LZ4S frame header/ },
  { name: "region sample rejects an outside view and preserves its folder", bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11] }), rect: { x: 60, y: 8, width: 8, height: 4 }, error: /outside/ },
]) {
  test(invalid.name, { timeout: 5000 }, async (t) => {
    const capture = captureSession(t, invalid);
    await assert.rejects(regionSample(capture.session, invalid.rect), invalid.error);
    await capture.finish(false);
    assert.equal(stops(capture).length, 1);
    assert.equal(existsSync(capture.frameDir), true, "a failed sample must retain its capture evidence");
    assert.equal(capture.closed, true);
  });
}

test("region sample presentation failure stops during cleanup and preserves its original error", { timeout: 5000 }, async (t) => {
  const presentationError = new Error("presentation failed");
  const capture = captureSession(t, { presentationError });
  await assert.rejects(regionSample(capture.session, rect), (error) => error === presentationError);
  assert.equal(stops(capture).length, 0);
  await capture.finish(false);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 0 }]]);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

test("region sample stop failure remains failed after being caught and is not retried", { timeout: 5000 }, async (t) => {
  const stopError = new Error("capture stop failed");
  const capture = captureSession(t, { stopError });
  await assert.rejects(regionSample(capture.session, rect), (error) => error === stopError);
  await assert.rejects(capture.finish(true), /1 recording failed: .*capture stop failed/);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 42 }]]);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

test("region sample keeps the presentation error and reports a cleanup stop error", { timeout: 5000 }, async (t) => {
  const presentationError = new Error("presentation failed");
  const stopError = new Error("capture cleanup failed");
  const capture = captureSession(t, { presentationError, stopError });
  let cleaned = false;
  capture.session.cleanup(() => { cleaned = true; });
  await assert.rejects(regionSample(capture.session, rect), (error) => error === presentationError);
  await assert.rejects(capture.finish(false), (error) => error === stopError);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 0 }]]);
  assert.ok(capture.diagnostics.some((line) => /cleanup failed: Error: capture cleanup failed/.test(line)));
  assert.equal(cleaned, true, "the remaining session cleanup must run after stop fails");
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

test("region sample preserves a successful sample when the final error audit fails", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [10, 11] }) });
  assert.deepEqual(await regionSample(capture.session, rect), [12, 34, 56]);
  appendFileSync(capture.log, `${JSON.stringify({ ts_us: 1791000000000001, seq: 2, level: "error", layer: "host",
    event: "host.test.failed", fields: {} })}\n`);
  await assert.rejects(capture.finish(true), /application logged 1 error/);
  assert.equal(existsSync(capture.frameDir), true, "a later audit failure must retain the sampled capture");
  assert.equal(stops(capture).length, 1);
  assert.equal(capture.closed, true);
});

test("region cells retain their sample until successful session finalization", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [5, 8] }) });
  assert.deepEqual(await regionCells(capture.session, "fixture-probe", [{ col: 0, row: 0 }]), [[12, 34, 56]]);
  assert.equal(existsSync(capture.frameDir), true, "cell capture must remain until finalization");
  await capture.finish(true);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 42 }]]);
  assert.equal(existsSync(capture.frameDir), false);
  assert.equal(capture.closed, true);
});

for (const geometry of [
  { name: "region cells include display scale", scale: 2, contentScale: 1, origin: [0, 0], point: [10, 17] },
  { name: "region cells include capture content scale", scale: 1, contentScale: 2, origin: [0, 0], point: [10, 17] },
  { name: "region cells include capture content origin", scale: 1, contentScale: 1, origin: [16, 24], point: [21, 32] },
  { name: "region cells include combined capture scales and origin", scale: 2, contentScale: 1.5, origin: [3, 5], point: [20, 35] },
  { name: "region cells include document offsets before capture conversion", scale: 2, contentScale: 1.5, origin: [3, 5],
    view: { document: { x: 3, y: 2 }, x: 4, y: 8 }, point: [29, 41] },
  { name: "region cells stay inside a one-pixel cell", scale: 1, contentScale: 1, origin: [0, 0],
    cellWidth: 1, cellHeight: 1, point: [4, 8] },
]) {
  test(geometry.name, { timeout: 5000 }, async (t) => {
    const capture = captureSession(t, { ...geometry, bytes: capturedFrame(geometry) });
    assert.deepEqual(await regionCells(capture.session, "fixture-probe", [{ col: 0, row: 0 }]), [[12, 34, 56]],
      "the selected cell must read its marked capture pixel rather than the surrounding white pixels");
    await capture.finish(true);
    assert.equal(stops(capture).length, 1);
  });
}

test("region cells convert the device cell size of the frame to CSS pixels", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { frameScale: 2, cellWidth: 16, cellHeight: 8,
    bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [13, 12] }) });
  assert.deepEqual(await regionCells(capture.session, "fixture-probe", [{ col: 1, row: 1 }]), [[12, 34, 56]],
    "a cell of 16 by 8 device pixels at scale 2 is 8 by 4 CSS pixels of the region element");
  await capture.finish(true);
  assert.equal(stops(capture).length, 1);
});

test("region cells read each requested row and column in order", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [16, 24], marks: [
    { point: [21, 32], color: [12, 34, 56] },
    { point: [37, 36], color: [78, 90, 123] },
  ] }) });
  assert.deepEqual(await regionCells(capture.session, "fixture-probe", [{ col: 2, row: 1 }, { col: 0, row: 0 }]),
    [[78, 90, 123], [12, 34, 56]], "each request must sample its own cell in the supplied order");
  await capture.finish(true);
});

test("region cells reject a cell outside the capture and keep its evidence", { timeout: 5000 }, async (t) => {
  const capture = captureSession(t, { bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [5, 8] }) });
  await assert.rejects(regionCells(capture.session, "fixture-probe", [{ col: 8, row: 0 }]), /outside/);
  await capture.finish(false);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(stops(capture).length, 1);
});

test("region cell presentation failure stops during cleanup and retains its evidence", { timeout: 5000 }, async (t) => {
  const presentationError = new Error("cell presentation failed");
  const capture = captureSession(t, { presentationError });
  await assert.rejects(regionCells(capture.session, "fixture-probe", [{ col: 0, row: 0 }]),
    (error) => error === presentationError);
  await capture.finish(false);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 0 }]]);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

test("region cell stop failure remains failed after being caught and is not retried", { timeout: 5000 }, async (t) => {
  const stopError = new Error("cell capture stop failed");
  const capture = captureSession(t, { stopError });
  await assert.rejects(regionCells(capture.session, "fixture-probe", [{ col: 0, row: 0 }]),
    (error) => error === stopError);
  await assert.rejects(capture.finish(true), /1 recording failed: .*cell capture stop failed/);
  assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 42 }]]);
  assert.equal(existsSync(capture.frameDir), true);
  assert.equal(capture.closed, true);
});

for (const invalid of [
  { name: "region cells preserve an empty capture", empty: true, error: /^Error: the recording lost 7 stills of the cell capture: still 0 / },
  { name: "region cells preserve a corrupt capture", bytes: Buffer.from("broken"), error: /complete LZ4S frame header/ },
  { name: "region cells preserve a capture when the view read fails",
    bytes: capturedFrame({ scale: 1, contentScale: 1, origin: [0, 0], point: [5, 8] }),
    viewError: new Error("cell view read failed"), error: /cell view read failed/ },
]) {
  test(invalid.name, { timeout: 5000 }, async (t) => {
    const capture = captureSession(t, invalid);
    await assert.rejects(regionCells(capture.session, "fixture-probe", [{ col: 0, row: 0 }]), invalid.error);
    await capture.finish(false);
    assert.deepEqual(stops(capture), [["diagnostics.capture.stop", { after: 42 }]]);
    assert.equal(existsSync(capture.frameDir), true);
    assert.equal(capture.closed, true);
  });
}
