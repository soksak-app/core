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
const nativeMarker = [0, 255, 255];

function viewportMarkerFrame({ scale = 1, missing = null, secondMarker = false, overdraw = false,
  markerWidthCss = 60, markerTop = 35, cardRight = 110, markerShift = 0, markerColor = viewportMarker } = {}) {
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
    const renderedMarker = [markerColor[0], markerColor[1] - markerShift, markerColor[2] - markerShift];
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
  drawMarker(30, markerTop, 30 + markerWidthCss, 130, missing);
  if (secondMarker) drawMarker(secondCardLeft + 20, markerTop, secondCardLeft + 80, 130);
  if (overdraw) paint(45 * scale, 80 * scale,
    [markerColor[0], markerColor[1] - markerShift, markerColor[2] - markerShift]);
  return { width, height, stride, data, scale, contentScale: 1, content: { x: 0, y: 0 }, time: 100 };
}

function nativeMarkerDeclaration(enabled = true) {
  return { enabled, kind: "native", markerColor: nativeMarker, borderWidthPt: 2 };
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
  const markerRight = cardRight - 6;
  for (let y = 20; y < 62; y++) for (let x = 14; x < markerRight; x++) {
    if (x < 16 || x >= markerRight - 2 || y < 22 || y >= 60) paint(x, y, nativeMarker);
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
  const sequence = [];
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
    sequence,
    cleanups: [],
    cleanup(callback) { this.cleanups.push(callback); },
    stopAfter: undefined,
    async record() { sequence.push("record-start"); return { async stop(options) {
      sequence.push("record-stop");
      session.stopAfter = options?.after;
      return { frames: captureDirectory, count: 2, limited: false };
    } }; },
    async get(name) {
      if (name === "core.grid") return grid;
      if (name === "host.window") return host;
      if (name === "core.surfaces") return surfaces;
      assert.fail(`unexpected session read ${name}`);
    },
    async request(name, params = {}) {
      if (name === "diagnostics.clock") return { mono_ns: "10000000" };
      assert.equal(name, "diagnostics.document.viewport-marker");
      assert.deepEqual(params, { surface: "view-a", document: "studio", enabled: params.enabled });
      sequence.push(params.enabled);
      return nativeMarkerDeclaration(params.enabled);
    },
    async run(name) {
      assert.equal(name, "core.grid.size");
      const placement = { level: "debug", seq: 1, event: "host.trace.surface", ts_us: 10050, mono_ns: 10050000,
        fields: { phase: "placed", surface: "view-a", x: 0, y: 0, w: 50, h: 40, visible: true } };
      const content = { level: "debug", seq: 2, event: "plugin.hwp.view.content_frame",
        ts_us: 10100, mono_ns: 10100000, surface: "view-a", fields: { sequence: 1,
          documentTimeOriginMs: 10, firstResizeAtMs: 0.1, resizeAtMs: 0.1, resizeCount: 1, frameTimeMs: 0.1, width: 50, height: 40 } };
      appendFileSync(join(logs, "host-1-1.jsonl"), `${JSON.stringify(placement)}\n${JSON.stringify(content)}\n`);
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
  return { markerColor: viewportMarker, borderWidth: 2, rect: { left: 0, top: 0, right: 70, bottom: 42 },
    innerWidth: 70, innerHeight: 42, clientWidth: 70, clientHeight: 42,
    visualViewport: { width: 70, height: 42, offsetLeft: 0, offsetTop: 0, scale: 1 },
    fixedContainingBlock: { transform: "none", perspective: "none", filter: "none", contain: "none",
      willChange: "auto", containerType: "normal" } };
}

function layoutDeadlineSession(root, captureDirectory, lastFrameTimeMs) {
  const logs = join(root, "logs");
  mkdirSync(logs);
  mkdirSync(captureDirectory);
  writeFileSync(join(logs, "host-1-1.jsonl"), "");
  writeLayoutFrame(captureDirectory, 0, 5, 90);
  writeLayoutFrame(captureDirectory, 1, 15, 95);
  if (lastFrameTimeMs > 15) writeLayoutFrame(captureDirectory, 2, lastFrameTimeMs, 95);
  const grid = (width) => ({ plane: { x: 0, y: 0 }, cards: [{ id: "card-a", x: 10, y: 8, w: width, h: 64 }] });
  const surfaceRect = (width) => ({ x: 10, y: 8, w: width, h: 64 });
  const documents = (width) => ({ documents: [
    { surface: "view-a", document: "", visible: true, frame: { x: 10, y: 8, width, height: 64 } },
    { surface: "view-a", document: "studio", visible: true,
      frame: { x: 14, y: 20, width: width - 10, height: 42 } },
  ] });
  let gridReads = 0;
  let hostReads = 0;
  const session = {
    app: { configDir: root },
    cleanups: [],
    cleanup(callback) { this.cleanups.push(callback); },
    stopAfter: undefined,
    async record() { return { async stop(options) {
      session.stopAfter = options?.after;
      return { frames: captureDirectory, count: lastFrameTimeMs > 15 ? 3 : 2, limited: false };
    } }; },
    async get(name) {
      if (name === "core.grid") return grid(++gridReads === 1 ? 80 : 85);
      if (name === "host.window") return documents(++hostReads === 1 ? 80 : 85);
      if (name === "core.surfaces") return [{ surface: "view-a", declared: surfaceRect(85), applied: surfaceRect(85) }];
      assert.fail(`unexpected session read ${name}`);
    },
    async request(name, params = {}) {
      if (name === "diagnostics.clock") return { mono_ns: "10000000" };
      assert.equal(name, "diagnostics.document.viewport-marker");
      assert.deepEqual(params, { surface: "view-a", document: "studio", enabled: params.enabled });
      return nativeMarkerDeclaration(params.enabled);
    },
    async run(name) {
      assert.equal(name, "core.grid.size");
      const placement = { level: "debug", seq: 1, event: "host.trace.surface", ts_us: 10050, mono_ns: 10050000,
        fields: { phase: "placed", surface: "view-a", x: 10, y: 8, w: 85, h: 64, visible: true } };
      const content = { level: "debug", seq: 2, event: "plugin.hwp.view.content_frame",
        ts_us: 10100, mono_ns: 10100000, surface: "view-a", fields: { sequence: 1,
          documentTimeOriginMs: 10, firstResizeAtMs: 0.1, resizeAtMs: 0.1, resizeCount: 1, frameTimeMs: 0.1, width: 85, height: 64 } };
      appendFileSync(join(logs, "host-1-1.jsonl"), `${JSON.stringify(placement)}\n${JSON.stringify(content)}\n`);
    },
    async presented() { return { displayed: 15 }; },
    async rect(name, unused, surface) {
      assert.equal(name, "hwp.studio");
      assert.equal(surface, "view-a");
      return { x: 14, y: 20, width: 75, height: 42 };
    },
    async flushLog() {},
  };
  const descriptor = {
    plugin: "hwp",
    async startContentTrace() { return { enabled: true, studioViewport: viewportMarkerDeclarationForLayout() }; },
    async stopContentTrace() { return { enabled: false, studioViewport: null }; },
  };
  const theme = { card: "#191b24", bg: "#101117", edge: "#2b2e3d", focus: "#ff0000" };
  return { session, descriptor, theme };
}

test("HWP unmatched layout geometry reports captured native document frames", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-layout-evidence-"));
  const captureDirectory = join(root, "capture");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { session, descriptor, theme } = layoutFailureSession(root, captureDirectory);
  await assert.rejects(layoutObservation({ diagnostic() {} }, session, descriptor, "view-a", "card-a", theme, 0), (error) => {
    assert.match(error.message, /HWP pixel geometry evidence/);
    const evidence = JSON.parse(error.message.slice(error.message.indexOf("HWP pixel geometry evidence ")
      + "HWP pixel geometry evidence ".length));
    assert.deepEqual(evidence.nativeDocumentBefore, { x: 7, y: 11, width: 36, height: 21 });
    assert.deepEqual(evidence.nativeDocumentAfter, evidence.nativeDocumentBefore);
    assert.equal(evidence.frameResiduals.length, 2);
    assert.match(error.cause.message, /no changed frame matching the new declared slot/);
    return true;
  });
  for (const cleanup of session.cleanups) await cleanup();
  assert.deepEqual(session.sequence, [true, "record-start", "record-stop", false],
    "native marker must bracket the capture and stop after recording finalizes");
});

test("HWP layout recording covers the full display deadline after presentation", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-layout-deadline-"));
  const captureDirectory = join(root, "capture");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { session, descriptor, theme } = layoutFailureSession(root, captureDirectory);
  await assert.rejects(layoutObservation({ diagnostic() {} }, session, descriptor, "view-a", "card-a", theme, 0), (error) => {
    assert.equal(session.stopAfter, 115,
      "recording must include the 100 ms display allowance after the presented layout");
    assert.match(error.message, /HWP pixel geometry evidence/);
    return true;
  });
});

test("HWP layout rejects an incomplete capture before judging absent document text", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-layout-incomplete-"));
  const captureDirectory = join(root, "capture");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { session, descriptor, theme } = layoutDeadlineSession(root, captureDirectory, 114.9);
  let recognized = 0;
  await assert.rejects(layoutObservation({ diagnostic() {} }, session, descriptor, "view-a", "card-a", theme, 0, {
    recognizeFrame: async () => { recognized += 1; return { lines: [] }; },
  }), /HWP layout recording ended at 114\.9 ms before the 100 ms content deadline at 115 ms/);
  assert.equal(session.stopAfter, 115);
  assert.equal(recognized, 0, "an incomplete recording must not be judged as a missing-content failure");
});

test("HWP layout judges absent document text only after the full content deadline is captured", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-layout-complete-"));
  const captureDirectory = join(root, "capture");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { session, descriptor, theme } = layoutDeadlineSession(root, captureDirectory, 115);
  let recognized = 0;
  await assert.rejects(layoutObservation({ diagnostic() {} }, session, descriptor, "view-a", "card-a", theme, 0, {
    recognizeFrame: async () => { recognized += 1; return { lines: [] }; },
  }), /no recorded frame contains expected content/);
  assert.equal(session.stopAfter, 115);
  assert.ok(recognized > 0, "a complete recording with absent text must reach captured-pixel OCR");
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

test("HWP reclaim captures the opened group before reclaim closes the warm motion view", { timeout: 5000 }, async () => {
  const opened = ["hwp-a", "hwp-b", "hwp-c", "hwp-d", "hwp-e", "hwp-warm"];
  const live = new Set(opened);
  let groupAtReclaim;
  const session = {
    async run(command, args) {
      assert.fail(`the HWP case closed ${args?.tab ?? command} before reclaim owned the initial group`);
    },
  };
  const start = { warmDisplay: { surface: "hwp-warm" }, opened: opened.map((surface) => ({ surface })) };
  await hwpCase.collectHwpReclaimAfterMotion({}, session, {}, start, {}, async (_t, _s, _descriptor, views) => {
    groupAtReclaim = [...live].sort();
    assert.deepEqual(views.map(({ surface }) => surface).sort(), [...opened].sort());
    for (const { surface } of views) live.delete(surface);
    return [];
  });
  assert.deepEqual(groupAtReclaim, [...opened].sort(),
    "reclaim must capture the complete still-open group before it closes the warm motion view");
  assert.deepEqual([...live], [], "the reclaim collector closes every view in the complete opening set");
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
  assert.throws(() => assertHwpFrameMatchesSlot({ ...geometry, frameIndex: 7, timeMs: 12,
    nativeRectPt: { ...geometry.nativeRectPt, right: 88 } }, { left: 8, top: 6, right: 8, bottom: 6 }), (error) => {
    assert.match(error.message, /differ from the declared slot/);
    const evidence = JSON.parse(error.message.slice(error.message.indexOf("HWP frame geometry evidence ")
      + "HWP frame geometry evidence ".length));
    assert.equal(evidence.frameIndex, 7);
    assert.equal(evidence.timeMs, 12);
    assert.equal(evidence.actualEdgesPt.right, 88);
    assert.equal(evidence.expectedEdgesPt.right, 92);
    assert.deepEqual(evidence.slotInsetsPt, { left: 8, top: 6, right: 8, bottom: 6 });
    return true;
  });
});

test("HWP native viewport marker measures native studio bounds at fixed and fractional capture scales", { timeout: 5000 }, () => {
  const themeGeometry = { cardColor: geometryColors.card, planeColor: geometryColors.plane,
    borderColors: [geometryColors.border], cornerRadiusPt: 0 };
  const targetRect = { x: 30, y: 36, width: 60, height: 94 };
  const measure = (frame, declaration = nativeMarkerDeclaration()) => hwpCase.measureHwpNativeMarkerFrame(frame,
    declaration, { targetRect, themeGeometry });
  const slotInsetsPt = { left: 20, top: 26, right: 20, bottom: 20 };
  const baseline = measure(viewportMarkerFrame({ markerTop: 36, markerColor: nativeMarker }));
  assert.deepEqual(baseline.nativeRectPt, { left: 30, top: 36, right: 90, bottom: 130 });
  assert.equal(baseline.geometryEvidence, "native region bounds alignment");
  assert.deepEqual(baseline.nativeMarker, { color: nativeMarker, borderWidthPt: 2, captureRatio: 1 });
  assert.equal(assertHwpFrameMatchesSlot(baseline, slotInsetsPt), 0);
  assert.deepEqual(measure(viewportMarkerFrame({ markerTop: 36, markerShift: 1, markerColor: nativeMarker })).nativeRectPt,
    baseline.nativeRectPt, "the shared four-channel tolerance must apply to every marker pixel predicate");
  assert.throws(() => measure(viewportMarkerFrame({ markerTop: 36, markerShift: 5, markerColor: nativeMarker })),
    /no opaque content-color pixels/, "marker matching must stop at the shared four-channel tolerance");
  for (const edge of ["left", "top", "right", "bottom"]) {
    assert.throws(() => measure(viewportMarkerFrame({ markerTop: 36, missing: edge, markerColor: nativeMarker })), /four-edge border/,
      `${edge} border omission must fail`);
  }
  assert.deepEqual(measure(viewportMarkerFrame({ markerTop: 36, secondMarker: true, markerColor: nativeMarker })).nativeRectPt,
    baseline.nativeRectPt, "a native marker in another card must not replace the selected studio marker");
  assert.throws(() => measure(viewportMarkerFrame({ markerTop: 36, overdraw: true, markerColor: nativeMarker })),
    /extra cyan pixels in the selected card/);
  for (const scale of [1.5, 2]) {
    const scaled = measure(viewportMarkerFrame({ scale, markerTop: 36, markerColor: nativeMarker }));
    assert.deepEqual(scaled.nativeRectPt, baseline.nativeRectPt,
      `${scale} capture pixels per point must preserve the measured native slot`);
    assert.equal(assertHwpFrameMatchesSlot(scaled, slotInsetsPt), 0);
  }
  const resizedSlot = measure(viewportMarkerFrame({ markerTop: 36, markerWidthCss: 80, cardRight: 130,
    markerColor: nativeMarker }));
  assert.deepEqual(resizedSlot.cardRectPt, { left: 10, top: 10, right: 130, bottom: 150 });
  assert.deepEqual(resizedSlot.nativeRectPt, { left: 30, top: 36, right: 110, bottom: 130 },
    "native view bounds must follow the current captured placement");
  assert.equal(assertHwpFrameMatchesSlot(resizedSlot, slotInsetsPt), 0);
  assert.throws(() => measure(viewportMarkerFrame({ markerTop: 36, markerColor: nativeMarker }),
    { ...nativeMarkerDeclaration(), borderWidthPt: 3 }), /exactly 2 points/);
  assert.throws(() => measure(viewportMarkerFrame({ markerTop: 36, markerColor: nativeMarker }),
    { ...nativeMarkerDeclaration(), kind: "html" }), /native view layer/);
});

test("HWP native marker starts before capture and is removed after capture failures", { timeout: 1000 }, async () => {
  const calls = [];
  const cleanups = [];
  const session = { cleanup(callback) { cleanups.push(callback); }, async request(method, params) {
      assert.equal(method, "diagnostics.document.viewport-marker");
      assert.deepEqual(params, { surface: "view-a", document: "studio", enabled: params.enabled });
      calls.push(params.enabled);
      return params.enabled ? nativeMarkerDeclaration() : nativeMarkerDeclaration(false);
    } };
  await assert.rejects(hwpCase.withHwpNativeMarker(session, "view-a", async () => {
    calls.push("capture");
    throw new Error("capture failed");
  }), /capture failed/);
  assert.deepEqual(calls, [true, "capture", false]);
  await cleanups[0]();
  assert.deepEqual(calls, [true, "capture", false], "session cleanup must not repeat a completed stop");
});

test("HWP native marker cleanup runs after an invalid successful start reply", { timeout: 1000 }, async () => {
  const calls = [];
  const cleanups = [];
  const session = { cleanup(callback) { cleanups.push(callback); }, async request(_method, params) {
      calls.push(params.enabled);
      return params.enabled ? { ...nativeMarkerDeclaration(), markerColor: viewportMarker }
        : nativeMarkerDeclaration(false);
    } };
  await assert.rejects(hwpCase.withHwpNativeMarker(session, "view-a", async () => assert.fail("invalid marker ran capture")),
    /cyan RGB token/);
  assert.deepEqual(calls, [true, false]);
  await cleanups[0]();
  assert.deepEqual(calls, [true, false], "validation rollback must disable the deferred cleanup after success");
});

test("HWP native marker forwards a failed start without issuing a stop", { timeout: 1000 }, async () => {
  const calls = [];
  const cleanups = [];
  const session = { cleanup(callback) { cleanups.push(callback); }, async request(_method, params) {
    calls.push(params.enabled);
    throw new Error("native marker startup failed and rolled back");
  } };
  await assert.rejects(hwpCase.withHwpNativeMarker(session, "view-a", async () => "unreachable"),
    /native marker startup failed and rolled back/);
  assert.deepEqual(calls, [true]);
  assert.equal(cleanups.length, 0);
});

test("HWP native marker retries a failed stop during session cleanup", { timeout: 1000 }, async () => {
  const calls = [];
  const cleanups = [];
  let stopAttempts = 0;
  const session = {
    cleanup(callback) { cleanups.push(callback); },
    async request(_method, params) {
      calls.push(params.enabled);
      if (params.enabled) return nativeMarkerDeclaration();
      stopAttempts++;
      if (stopAttempts === 1) throw new Error("native marker stop reply was lost");
      return nativeMarkerDeclaration(false);
    },
  };
  await assert.rejects(hwpCase.withHwpNativeMarker(session, "view-a", async () => "captured"),
    /native marker stop reply was lost/);
  assert.equal(cleanups.length, 1, "a successfully started marker must retain a final session cleanup");
  await cleanups[0]();
  assert.deepEqual(calls, [true, false, false]);
});
