import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";

import * as hwpCase from "../benchmark/cases/hwp.mjs";
import { assertHwpFrameMatchesSlot, hwpDocumentHistoryEvidence, hwpFirstContentFrame,
  hwpViewDescriptor, layoutObservation }
  from "../benchmark/cases/hwp.mjs";
import { processStartSamples } from "../view-metrics-collection.mjs";
import { viewProcessPids } from "../view-process-footprint.mjs";

const geometryColors = { content: [30, 30, 30], card: [25, 27, 36], plane: [16, 17, 23], border: [43, 46, 61] };
const viewportMarker = [255, 0, 255];

function viewportMarkerFrame({ scale = 1, missing = null, secondMarker = false, overdraw = false,
  markerWidthCss = 60, cardRight = 110, markerShift = 0 } = {}) {
  const width = 240 * scale, height = 160 * scale, stride = width * 4;
  const data = new Uint8Array(stride * height);
  const paint = (x, y, color) => {
    const offset = y * stride + x * 4;
    data[offset] = color[2]; data[offset + 1] = color[1]; data[offset + 2] = color[0]; data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, geometryColors.plane);
  const secondCardLeft = cardRight + 20;
  for (const [left, top, right, bottom] of [[10, 10, cardRight, 150], [secondCardLeft, 10, 230, 150]]) {
    for (let y = top * scale; y < bottom * scale; y++) for (let x = left * scale; x < right * scale; x++) {
      const edge = x < (left + 1) * scale || x >= (right - 1) * scale
        || y < (top + 1) * scale || y >= (bottom - 1) * scale;
      paint(x, y, edge ? geometryColors.border : geometryColors.card);
    }
  }
  for (const left of [20, secondCardLeft + 10]) for (let y = 45 * scale; y < 120 * scale; y++) {
    for (let x = left * scale; x < (left + 80) * scale; x++) paint(x, y, geometryColors.content);
  }
  const drawMarker = (left, top, right, bottom, missingSide = null) => {
    const thickness = 2 * scale;
    const renderedMarker = [viewportMarker[0], viewportMarker[1] + markerShift, viewportMarker[2] - markerShift];
    for (let y = top * scale; y < bottom * scale; y++) for (let x = left * scale; x < right * scale; x++) {
      const edge = x < left * scale + thickness || x >= right * scale - thickness
        || y < top * scale + thickness || y >= bottom * scale - thickness;
      if (!edge) continue;
      const onMissing = missingSide === "left" && x < left * scale + thickness
          && y >= top * scale + thickness && y < bottom * scale - thickness
        || missingSide === "right" && x >= right * scale - thickness
          && y >= top * scale + thickness && y < bottom * scale - thickness
        || missingSide === "top" && y < top * scale + thickness
          && x >= left * scale + thickness && x < right * scale - thickness
        || missingSide === "bottom" && y >= bottom * scale - thickness
          && x >= left * scale + thickness && x < right * scale - thickness;
      if (!onMissing) paint(x, y, renderedMarker);
    }
  };
  drawMarker(30, 35, 30 + markerWidthCss, 130, missing);
  if (secondMarker) drawMarker(secondCardLeft + 20, 35, secondCardLeft + 80, 130);
  if (overdraw) paint(45 * scale, 80 * scale,
    [viewportMarker[0], viewportMarker[1] + markerShift, viewportMarker[2] - markerShift]);
  return { width, height, stride, data, scale, contentScale: 1, content: { x: 0, y: 0 }, time: 100 };
}

function viewportMarkerDeclaration() {
  return { markerColor: viewportMarker, borderWidth: 2,
    rect: { left: 0, top: 0, right: 60, bottom: 95 }, innerWidth: 60, innerHeight: 95,
    clientWidth: 60, clientHeight: 95,
    visualViewport: { width: 60, height: 95, offsetLeft: 0, offsetTop: 0, scale: 1 },
    fixedContainingBlock: { transform: "none", perspective: "none", filter: "none", contain: "none",
      willChange: "auto", containerType: "normal" } };
}

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
  for (let y = 11; y < 18; y++) for (let x = 14; x < 86; x++) paint(x, y, geometryColors.content);
  for (let y = 20; y < 62; y++) for (let x = 14; x < 86; x++) {
    if (x < 16 || x >= 84 || y < 22 || y >= 60) paint(x, y, viewportMarker);
  }
  let remaining = pixels.length - 15;
  const encoded = [Buffer.from([0xf0])];
  while (remaining >= 255) { encoded.push(Buffer.from([255])); remaining -= 255; }
  encoded.push(Buffer.from([remaining]), pixels);
  const block = Buffer.concat(encoded);
  const header = Buffer.alloc(80);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  header.writeUInt32LE(stride, 8);
  [0, 0, width, height, 1, 1, time].forEach((value, field) => header.writeDoubleLE(value, 12 + field * 8));
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
  const descriptor = { plugin: "hwp",
    async startContentTrace() { return { enabled: true, studioViewport: viewportMarkerDeclarationForLayout() }; },
    async stopContentTrace() { return { enabled: false, studioViewport: null }; } };
  const theme = { card: "#191b24", bg: "#101117", edge: "#2b2e3d", focus: "#ff0000" };
  return { session, descriptor, theme, grid, surfaces, host };
}

function viewportMarkerDeclarationForLayout() {
  return { markerColor: viewportMarker, borderWidth: 2, rect: { left: 0, top: 0, right: 72, bottom: 42 },
    innerWidth: 72, innerHeight: 42, clientWidth: 72, clientHeight: 42,
    visualViewport: { width: 72, height: 42, offsetLeft: 0, offsetTop: 0, scale: 1 },
    fixedContainingBlock: { transform: "none", perspective: "none", filter: "none", contain: "none",
      willChange: "auto", containerType: "normal" } };
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

test("HWP geometry compares measured studio edges with the declared slot insets", () => {
  const geometry = {
    cardRectPt: { left: 0, top: 0, right: 100, bottom: 80 },
    nativeRectPt: { left: 8, top: 6, right: 92, bottom: 74 },
  };
  assert.equal(assertHwpFrameMatchesSlot(geometry, { left: 8, top: 6, right: 8, bottom: 6 }), 0);
  assert.throws(() => assertHwpFrameMatchesSlot({ ...geometry,
    nativeRectPt: { ...geometry.nativeRectPt, right: 88 } }, { left: 8, top: 6, right: 8, bottom: 6 }), /differs from its declared slot/);
});

test("HWP marker measurement requires a complete four-edge border", { timeout: 5000 }, () => {
  assert.equal(typeof hwpCase.measureHwpViewportMarkerFrame, "function",
    "HWP marker-assisted viewport geometry consumer is required");
  const themeGeometry = { contentColor: geometryColors.content, cardColor: geometryColors.card,
    planeColor: geometryColors.plane, borderColors: [geometryColors.border] };
  const targetRect = { x: 30, y: 35, width: 60, height: 95 };
  const measure = (frame) => hwpCase.measureHwpViewportMarkerFrame(frame,
    viewportMarkerDeclaration(), { targetRect, themeGeometry });
  const slotInsetsPt = { left: 20, top: 25, right: 20, bottom: 20 };
  const oneToOne = measure(viewportMarkerFrame());
  assert.deepEqual(oneToOne.nativeRectPt, { left: 30, top: 35, right: 90, bottom: 130 });
  assert.equal(assertHwpFrameMatchesSlot(oneToOne, slotInsetsPt), 0);
  assert.deepEqual(measure(viewportMarkerFrame({ markerShift: 1 })).nativeRectPt, oneToOne.nativeRectPt,
    "the shared four-channel tolerance must apply to every marker pixel predicate");
  assert.throws(() => measure(viewportMarkerFrame({ markerShift: 5 })), /no opaque content-color pixels/,
    "marker matching must stop at the shared four-channel tolerance");
  for (const edge of ["left", "top", "right", "bottom"]) {
    assert.throws(() => measure(viewportMarkerFrame({ missing: edge })), /complete 2-pixel border/,
      `${edge} border omission must fail`);
  }
  assert.deepEqual(measure(viewportMarkerFrame({ secondMarker: true })).nativeRectPt,
    { left: 30, top: 35, right: 90, bottom: 130 }, "a marker in another card must not replace the target card marker");
  assert.throws(() => measure(viewportMarkerFrame({ overdraw: true })), /extra marker pixels in the selected card/);
  const invalidViewport = viewportMarkerDeclaration();
  invalidViewport.visualViewport.scale = 1.5;
  assert.throws(() => hwpCase.measureHwpViewportMarkerFrame(viewportMarkerFrame(), invalidViewport,
    { targetRect, themeGeometry }), /visual viewport is zoomed/);
  const twoToOne = measure(viewportMarkerFrame({ scale: 2 }));
  assert.deepEqual(twoToOne.nativeRectPt, { left: 30, top: 35, right: 90, bottom: 130 },
    "two capture pixels per CSS pixel must preserve the measured slot");
  assert.equal(assertHwpFrameMatchesSlot(twoToOne, slotInsetsPt), 0);
  const resizedSlot = measure(viewportMarkerFrame({ markerWidthCss: 80, cardRight: 130 }));
  assert.deepEqual(resizedSlot.cardRectPt, { left: 10, top: 10, right: 130, bottom: 150 });
  assert.deepEqual(resizedSlot.nativeRectPt, { left: 30, top: 35, right: 110, bottom: 130 },
    "the overlay bounds must follow a resized viewport after the initial diagnostic reply");
  assert.equal(assertHwpFrameMatchesSlot(resizedSlot, slotInsetsPt), 0);
});
