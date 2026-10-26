import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";

import { assertHwpFrameMatchesSlot, hwpDocumentHistoryEvidence, hwpFirstContentFrame, hwpGeometryPalette,
  hwpViewDescriptor, layoutObservation }
  from "../benchmark/cases/hwp.mjs";
import { processStartSamples } from "../view-metrics-collection.mjs";
import { viewProcessPids } from "../view-process-footprint.mjs";

const geometryColors = { content: [30, 30, 30], card: [25, 27, 36], plane: [16, 17, 23], border: [43, 46, 61] };

function writeLayoutFrame(directory, index, time, cardRight) {
  const width = 100, height = 80, stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  const paint = (x, y, color) => {
    const offset = y * stride + x * 4;
    pixels[offset] = color[2];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[0];
    pixels[offset + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, geometryColors.plane);
  for (let y = 8; y < 72; y++) for (let x = 10; x < cardRight; x++) {
    const edge = x === 10 || x === cardRight - 1 || y === 8 || y === 71;
    paint(x, y, edge ? geometryColors.border : geometryColors.card);
  }
  for (let y = 22; y < 64; y++) for (let x = 14; x < 86; x++) paint(x, y, geometryColors.content);
  let remaining = pixels.length - 15;
  const encoded = [Buffer.from([0xf0])];
  while (remaining >= 255) { encoded.push(Buffer.from([255])); remaining -= 255; }
  encoded.push(Buffer.from([remaining]), pixels);
  const block = Buffer.concat(encoded);
  const header = Buffer.alloc(80);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  header.writeUInt32LE(stride, 8);
  [0, 0, width, height, 1, 2, time].forEach((value, field) => header.writeDoubleLE(value, 12 + field * 8));
  header.write("LZ4B", 68, "ascii");
  header.writeUInt32LE(block.length, 72);
  header.writeUInt32LE(crc32(pixels), 76);
  writeFileSync(join(directory, `frame-${index}.bgra`), Buffer.concat([header, block]));
}

function layoutFailureSession(root, captureDirectory) {
  const logs = join(root, "logs");
  mkdirSync(logs);
  mkdirSync(captureDirectory);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  writeLayoutFrame(captureDirectory, 0, 5, 90);
  writeLayoutFrame(captureDirectory, 1, 15, 95);
  const grid = { plane: { x: 0, y: 0 }, cards: [{ id: "card-a", x: 5, y: 4, w: 40, h: 32 }] };
  const surfaces = [{ surface: "view-a", declared: { x: 10, y: 10, w: 10, h: 10 },
    applied: { x: 7, y: 11, w: 36, h: 21 } }];
  const host = { documents: [
    { surface: "view-a", document: "", visible: true, frame: { x: 0, y: 0, width: 50, height: 40 } },
    { surface: "view-a", document: "studio", visible: true, frame: { x: 7, y: 11, width: 36, height: 21 } },
  ] };
  const session = {
    app: { configDir: root },
    async record() { return { async stop() { return { frames: captureDirectory, count: 2, limited: false }; } }; },
    async get(name) {
      if (name === "core.grid") return grid;
      if (name === "host.window") return host;
      if (name === "core.surfaces") return surfaces;
      assert.fail(`unexpected session read ${name}`);
    },
    async request(name) { assert.equal(name, "diagnostics.clock"); return { mono_ns: "10000000" }; },
    async run(name) {
      assert.equal(name, "core.grid.size");
      appendFileSync(join(logs, "host-1-1.jsonl"), `${JSON.stringify({ level: "debug", seq: 1, event: "plugin.hwp.view.content_frame",
        ts_us: 10100, mono_ns: 10100000, surface: "view-a", fields: { sequence: 1,
          documentTimeOriginMs: 10, resizeAtMs: 0.1, frameTimeMs: 0.1, width: 50, height: 40 } })}\n`);
    },
    async presented() { return { displayed: 15 }; },
    async rect(name, unused, surface) {
      assert.equal(name, "hwp.studio");
      assert.equal(surface, "view-a");
      return { x: 7, y: 11, width: 10, height: 10 };
    },
    async flushLog() {},
  };
  const descriptor = { plugin: "hwp", async startContentTrace() {}, async stopContentTrace() { return {}; } };
  const theme = { card: "#191b24", bg: "#101117", edge: "#2b2e3d", focus: "#ff0000" };
  return { session, descriptor, theme, grid, surfaces, host };
}

test("HWP unmatched layout geometry reports captured native document frames", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-layout-evidence-"));
  const captureDirectory = join(root, "capture");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { session, descriptor, theme } = layoutFailureSession(root, captureDirectory);
  await assert.rejects(layoutObservation({ diagnostic() {} }, session, descriptor, "view-a", "card-a", theme), (error) => {
    assert.match(error.message, /HWP pixel geometry evidence/);
    const evidence = JSON.parse(error.message.slice(error.message.indexOf("HWP pixel geometry evidence ")
      + "HWP pixel geometry evidence ".length));
    assert.deepEqual(evidence.nativeDocumentBefore, { x: 7, y: 11, width: 36, height: 21 });
    assert.deepEqual(evidence.nativeDocumentAfter, evidence.nativeDocumentBefore);
    assert.equal(evidence.frameResiduals.length, 2);
    assert.match(error.cause.message, /no changed frame matching the new declared slot/);
    return true;
  });
});

test("HWP descriptor waits for its declared document status exposure", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-view-readiness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.SOKSAK_CAPTURE_TEXT;
  process.env.SOKSAK_CAPTURE_TEXT = previous ?? "not-invoked";
  const cleanups = [];
  try {
    const descriptor = await hwpViewDescriptor({
      async get(name) { assert.equal(name, "core.project"); return { root }; },
      cleanup(callback) { cleanups.push(callback); },
    });
    assert.equal(descriptor.readinessStatus, "hwp.document");
  } finally {
    for (const cleanup of cleanups) cleanup();
    if (previous === undefined) delete process.env.SOKSAK_CAPTURE_TEXT;
    else process.env.SOKSAK_CAPTURE_TEXT = previous;
  }
});

test("HWP reclaim evidence reads exact root and studio histories from the diagnostic reply", () => {
  assert.deepEqual(hwpDocumentHistoryEvidence({ historyEntries: 1, regionHistoryEntries: 1 }), {
    historyEntries: 1, regionHistoryEntries: 1,
  });
  assert.throws(() => hwpDocumentHistoryEvidence({ historyEntries: 1 }), /regionHistoryEntries/);
  assert.throws(() => hwpDocumentHistoryEvidence({ historyEntries: 1, regionHistoryEntries: 2 }), /exactly its initial entry/);
});

test("HWP process starts use the canonical shared event clock parser", () => {
  const surfaces = ["hwp-a"];
  const events = [
    { event: "host.trace.view.process-request", ts_us: 50_000_000, mono_ns: 1_000_000_000,
      fields: { plugin: "hwp", surface: "hwp-a" } },
    { event: "host.trace.view.process-ready", ts_us: 50_003_000, mono_ns: 1_003_000_000,
      fields: { plugin: "hwp", surface: "hwp-a" } },
  ];
  const [sample] = processStartSamples(events, surfaces, "hwp");
  assert.deepEqual({ requestAtMs: sample.requestAtMs, readyAtMs: sample.readyAtMs,
    requestTsUs: sample.requestTsUs, readyTsUs: sample.readyTsUs,
    requestMonoNs: sample.requestMonoNs, readyMonoNs: sample.readyMonoNs }, {
    requestAtMs: 1000, readyAtMs: 1003, requestTsUs: 50_000_000, readyTsUs: 50_003_000,
    requestMonoNs: 1_000_000_000, readyMonoNs: 1_003_000_000,
  });
});

test("HWP footprint group includes its root and attached studio document processes", () => {
  const host = { documents: [
    { surface: "hwp-a", document: "", process: 701 },
    { surface: "hwp-a", document: "studio", process: 702 },
    { surface: "other", document: "", process: 703 },
  ] };
  assert.deepEqual(viewProcessPids(host, ["hwp-a"]), [701, 702]);
});

test("HWP first-content sample requires OCR-confirmed decoded pixels in capture order", async () => {
  const recognized = [];
  const result = await hwpFirstContentFrame({
    captured: [{ time: 10 }, { time: 26 }, { time: 43 }],
    rect: { x: 0, y: 0, w: 20, h: 20 },
    directory: "/unused-with-recognizer",
    recognizeFrame: async (frame) => {
      recognized.push(frame.time);
      return { lines: frame.time === 26 ? ["속삭한글문서확인"] : ["blank"] };
    },
  });
  assert.deepEqual(recognized, [10, 26]);
  assert.deepEqual(result, {
    frameIndex: 1,
    frameCount: 3,
    timeMs: 26,
    proof: { expected: "속삭한글문서확인", actual: "속삭한글문서확인", lines: ["속삭한글문서확인"] },
  });
});

test("HWP card-anchor color comes from dominant opaque pixels in the studio top row", { timeout: 1000 }, () => {
  const width = 40, height = 30, stride = width * 4;
  const data = new Uint8Array(stride * height);
  const color = [241, 242, 243];
  for (let pixel = 0; pixel < width * height; pixel++) {
    const at = pixel * 4;
    data[at] = color[2]; data[at + 1] = color[1]; data[at + 2] = color[0]; data[at + 3] = 255;
  }
  const frame = { width, height, stride, data, scale: 1, contentScale: 1,
    content: { x: 0, y: 0 }, time: 100 };
  assert.deepEqual(hwpGeometryPalette(frame, { x: 0, y: 0, width, height }, {
    card: "#191b24", bg: "#101117", edge: "#2b2e3d", focus: "#ffb36b",
  }).contentColor, color);
});

test("HWP card-anchor sampling uses the top row rather than page pixels", { timeout: 1000 }, () => {
  const width = 40, height = 30, stride = width * 4;
  const data = new Uint8Array(stride * height);
  const paper = [255, 255, 255];
  const studio = [52, 58, 67];
  for (let index = 0; index < width * height; index++) {
    const at = index * 4;
    data[at] = paper[2]; data[at + 1] = paper[1]; data[at + 2] = paper[0]; data[at + 3] = 255;
  }
  for (let x = 0; x < width; x++) {
    const at = x * 4;
    data[at] = studio[2]; data[at + 1] = studio[1]; data[at + 2] = studio[0]; data[at + 3] = 255;
  }
  const frame = { width, height, stride, data, scale: 1, contentScale: 1,
    content: { x: 0, y: 0 }, time: 100 };
  assert.deepEqual(hwpGeometryPalette(frame, { x: 0, y: 0, width, height }, {
    card: "#191b24", bg: "#101117", edge: "#2b2e3d", focus: "#ffb36b",
  }).contentColor, studio);
});

test("HWP geometry compares measured studio edges with the declared slot insets", () => {
  const geometry = {
    cardRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    nativeRectPt: { left: 8, top: 6, right: 92, bottom: 74 },
  };
  assert.equal(assertHwpFrameMatchesSlot(geometry, { left: 8, top: 6, right: 8, bottom: 6 }), 0);
  assert.throws(() => assertHwpFrameMatchesSlot({ ...geometry,
    nativeRectPt: { ...geometry.nativeRectPt, right: 88 } }, { left: 8, top: 6, right: 8, bottom: 6 }), /differs from its declared slot/);
});
