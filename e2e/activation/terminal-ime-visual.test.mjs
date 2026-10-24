import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compositionFrameCandidates,
  mapCaptureRaster,
  measureRenderedCell,
  rasterizeCellBounds,
  validateRenderMetadata,
} from "./terminal-ime-visual.mjs";

function testWithTimeout(name, body) {
  test(name, { timeout: 2000 }, body);
}

const screenRenderFixture = JSON.parse(readFileSync(new URL("./fixtures/screen-render.json", import.meta.url), "utf8"));
const overlayRenderFixture = JSON.parse(readFileSync(new URL("./fixtures/screen-render-overlay.json", import.meta.url), "utf8"));

function renderFixture({ grapheme = "ㅏ", foreground = "#000000", background = "#ffffff",
  bounds = { x: 1.25, y: 1.25, width: 1.5, height: 2 }, underlineRect = { x: 0, y: 5, width: 4, height: 1 },
  cursor = {} } = {}) {
  const render = structuredClone(screenRenderFixture);
  render.glyphs = [{ ...render.glyphs[0], grapheme, foreground, background, bounds,
    underline: { rect: underlineRect } }];
  render.cursor = { ...render.cursor, ...cursor };
  return render;
}

const pixelPolicy = {
  schema: 1,
  glyphRows: [0, 4],
  underlineRows: [5, 6],
  background: [255, 255, 255],
  glyphForeground: [0, 0, 0],
  underlineForeground: [0, 0, 0],
  minimumColorDistance: 32,
  minimumGlyphPixels: 2,
  minimumUnderlineCoverage: 0.75,
};

function raster(width, height, columns, rows, data) {
  return { width, height, grid: { cols: columns, rows, cellWidth: width / columns,
    cellHeight: height / rows, x: 0, y: 0 }, format: "BGRA8", alpha: "premultiplied-first", colorSpace: "sRGB",
    bytesPerRow: width * 4, scale: 1, screenBounds: { x: 0, y: 0, width, height }, data };
}

function captureFor(source) {
  return { width: source.width, height: source.height, bytesPerRow: source.bytesPerRow,
    format: source.format, alpha: source.alpha, colorSpace: source.colorSpace, scaleFactor: source.scale,
    screenRect: source.screenBounds, contentRect: { x: 0, y: 0, width: source.screenBounds.width,
      height: source.screenBounds.height },
    data: source.data };
}

function semanticState(overrides = {}) {
  return {
    document: "ㅏ",
    compose: { text: "ㅏ", markedRange: { location: 0, length: 1 }, selectedRange: { location: 1, length: 0 } },
    cursor: { row: 0, col: 1, focused: true, preedit: "ㅏ" },
    geometry: { rows: 1, cols: 1, cellWidth: 4, cellHeight: 6, origin: { x: 0, y: 0 } },
    ...overrides,
  };
}

function blank(width = 4, height = 6) {
  return new Uint8Array(width * height * 4).fill(255);
}

function pixel(data, x, y, color, width = 4, bytesPerRow = width * 4) {
  const offset = y * bytesPerRow + x * 4;
  data.set([color[2], color[1], color[0], 255], offset);
}

function premultipliedPixel(data, x, y, color, alpha, width, bytesPerRow = width * 4) {
  const offset = y * bytesPerRow + x * 4;
  const scale = (channel) => Math.round(channel * alpha / 255);
  data.set([scale(color[2]), scale(color[1]), scale(color[0]), alpha], offset);
}

function compositionRaster({ glyph = true, underline = true, wrongUnderline = false } = {}) {
  const width = 12;
  const height = 6;
  const data = blank(width, height);
  if (glyph) {
    pixel(data, 1, 1, [0, 0, 0], width);
    pixel(data, 2, 2, [0, 0, 0], width);
  }
  if (underline) for (let x = 0; x < 4; x++) pixel(data, x, wrongUnderline ? 4 : 5, [0, 0, 0], width);
  return { width, height, bytesPerRow: width * 4, bytes: data, data,
    format: "BGRA8", alpha: "premultiplied-first", colorSpace: "sRGB", scaleFactor: 1,
    screenRect: { x: 0, y: 0, width, height }, contentRect: { x: 0, y: 0, width, height } };
}

function alignedSource(render, capture) {
  return {
    width: render.pixel.width,
    height: render.pixel.height,
    scale: capture.scaleFactor,
    screenBounds: { x: 0, y: 0, width: render.pixel.width / capture.scaleFactor,
      height: render.pixel.height / capture.scaleFactor },
    format: capture.format,
    alpha: capture.alpha,
    colorSpace: capture.colorSpace,
  };
}

function measure(capture, render, target, criteria) {
  return measureRenderedCell(capture, capture && render ? alignedSource(render, capture) : null,
    render, target, criteria);
}

testWithTimeout("ROI candidate set includes the exact target and preserves duplicate identity ambiguity", () => {
  const target = { generation: 1, raster: 2, sequence: 3 };
  const data = blank();
  const sourceRaster = raster(4, 6, 1, 1, data);
  const capture = captureFor(sourceRaster);
  const state = semanticState();
  const otherFrame = { generation: 1, raster: 2, sequence: 4 };
  const result = compositionFrameCandidates({ targetFrame: target, capture, cell: { row: 0, column: 0 },
    expectedState: state, sources: [
      { frame: target, raster: sourceRaster, state: { frame: target, semantic: state } },
      { frame: otherFrame, raster: sourceRaster, state: { frame: otherFrame, semantic: state } },
    ] });
  assert.deepEqual(result, { result: "candidate-set", target: "1/2/3", identities: ["1/2/3", "1/2/4"],
    ambiguous: true, reasons: [] });
  assert.throws(() => compositionFrameCandidates({ targetFrame: target, capture, cell: { row: 0, column: 0 },
    expectedState: state, sources: [
      { frame: target, raster: sourceRaster, state: { frame: target, semantic: state } },
      { frame: target, raster: sourceRaster, state: { frame: target, semantic: state } },
    ] }), /source identity 1\/2\/3 is duplicated/);
});

testWithTimeout("ROI candidates reject missing target, semantic disagreement, and fractional cell geometry", () => {
  const target = { generation: 1, raster: 2, sequence: 3 };
  const data = blank();
  const sourceRaster = raster(4, 6, 1, 1, data);
  const capture = captureFor(sourceRaster);
  const sourceFrame = { generation: 1, raster: 2, sequence: 4 };
  const source = { frame: sourceFrame, raster: sourceRaster,
    state: { frame: sourceFrame, semantic: semanticState({ document: "wrong" }) } };
  const result = compositionFrameCandidates({ targetFrame: target, capture, cell: { row: 0, column: 0 },
    expectedState: semanticState(), sources: [source] });
  assert.equal(result.result, "no-proof");
  assert.deepEqual(result.reasons, ["target-frame-not-in-roi-candidates", "candidate-semantic-state-differs"]);
  const fractionalRaster = raster(5, 6, 2, 1, new Uint8Array(5 * 6 * 4));
  assert.throws(() => compositionFrameCandidates({ targetFrame: target, capture: captureFor(fractionalRaster),
    cell: { row: 0, column: 0 }, expectedState: semanticState(),
    sources: [{ frame: target, raster: fractionalRaster, state: { frame: target, semantic: semanticState() } }] }),
  /integer cell-grid geometry is required/);
});

testWithTimeout("complete input and guard cell bytes reject an extra glyph outside the expected document", () => {
  const target = { generation: 1, raster: 2, sequence: 3 };
  const captureData = new Uint8Array(12 * 6 * 4).fill(255);
  const sourceData = captureData.slice();
  pixel(sourceData, 9, 2, [0, 0, 0]);
  const sourceRaster = raster(12, 6, 3, 1, sourceData);
  const capture = captureFor({ ...sourceRaster, data: captureData });
  const state = semanticState();
  const result = compositionFrameCandidates({ targetFrame: target, capture, cells: [
    { row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 },
  ], expectedState: state, sources: [{ frame: target, raster: sourceRaster,
    state: { frame: target, semantic: state } }] });
  assert.equal(result.result, "no-proof");
  assert.deepEqual(result.reasons, ["target-frame-not-in-roi-candidates", "no-roi-candidate"]);
});

testWithTimeout("ROI mapping uses source bounds, scale, grid inset, and padded capture strides", () => {
  const frame = { generation: 2, raster: 4, sequence: 9 };
  const sourceData = new Uint8Array(44 * 6).fill(255);
  const captureData = new Uint8Array(100 * 20).fill(255);
  for (let y = 0; y < 6; y++) for (let x = 2; x < 6; x++) {
    sourceData.set([0, 0, 0, 255], y * 44 + x * 4);
  }
  for (let y = 4; y < 10; y++) for (let x = 6; x < 10; x++) {
    captureData.set([0, 0, 0, 255], y * 100 + x * 4);
  }
  const sourceRaster = { width: 10, height: 6, bytesPerRow: 44, data: sourceData,
    format: "BGRA8", alpha: "premultiplied-first", colorSpace: "sRGB", scale: 2,
    screenBounds: { x: 10, y: 20, width: 5, height: 3 },
    grid: { rows: 1, cols: 2, cellWidth: 4, cellHeight: 6, x: 2, y: 0 } };
  const capture = { width: 24, height: 20, bytesPerRow: 100, data: captureData,
    format: "BGRA8", alpha: "premultiplied-first", colorSpace: "sRGB", scaleFactor: 2,
    screenRect: { x: 8, y: 18, width: 12, height: 10 }, contentRect: { x: 0, y: 0, width: 12, height: 10 } };
  const semantic = semanticState({ geometry: { rows: 1, cols: 2, cellWidth: 4, cellHeight: 6,
    origin: { x: 2, y: 0 } } });
  const result = compositionFrameCandidates({ targetFrame: frame, capture, cells: [{ row: 0, column: 0 }],
    expectedState: semantic, sources: [{ frame, raster: sourceRaster, state: { frame, semantic } }] });
  assert.equal(result.result, "candidate-set");
  assert.deepEqual(result.identities, ["2/4/9"]);
  for (const expected of [semanticState({ compose: { text: "ㅏ", markedRange: null,
    selectedRange: { location: 1, length: 0 } } }), semanticState({ geometry: { ...semanticState().geometry, cols: 2 } })]) {
    const changed = compositionFrameCandidates({ targetFrame: frame, capture, cells: [{ row: 0, column: 0 }],
      expectedState: expected, sources: [{ frame, raster: sourceRaster,
        state: { frame, semantic } }] });
    assert.equal(changed.result, "no-proof");
    assert.deepEqual(changed.reasons, ["candidate-semantic-state-differs"]);
  }
  for (const incomplete of [
    { document: "ㅏ" },
    semanticState({ compose: { text: "ㅏ", markedRange: null } }),
    semanticState({ cursor: { row: 0, col: 1, preedit: "ㅏ" } }),
    semanticState({ geometry: { rows: 1, cellWidth: 4, cellHeight: 6, origin: { x: 0, y: 0 } } }),
  ]) {
    assert.throws(() => compositionFrameCandidates({ targetFrame: frame, capture,
      cells: [{ row: 0, column: 0 }], expectedState: incomplete,
      sources: [{ frame, raster: sourceRaster, state: { frame, semantic } }] }), /required/);
  }
});

testWithTimeout("capture content bounds and pixel storage must contain the image ROI", () => {
  const frame = { generation: 2, raster: 4, sequence: 9 };
  const sourceRaster = raster(4, 6, 1, 1, blank());
  const state = semanticState();
  const source = { frame, raster: sourceRaster, state: { frame, semantic: state } };
  for (const capture of [
    { ...captureFor(sourceRaster), contentRect: { x: 0, y: 0, width: 0, height: 6 } },
    { ...captureFor(sourceRaster), contentRect: { x: 0, y: 0, width: 5, height: 6 } },
    { ...captureFor(sourceRaster), data: new Uint8Array(1) },
  ]) {
    assert.throws(() => compositionFrameCandidates({ targetFrame: frame, capture,
      cells: [{ row: 0, column: 0 }], expectedState: state, sources: [source] }), /capture/);
  }
});

testWithTimeout("renderer geometry is frame-bound and rejects unsupported pixel layouts", () => {
  const frame = screenRenderFixture.frame;
  const cursor = { shape: "block", focused: true, visible: true, blinkVisible: true };
  const render = renderFixture({ grapheme: screenRenderFixture.glyphs[0].grapheme, cursor: {
    rect: { x: 0, y: 0, width: 1, height: 1 }, shape: "block", focused: true,
    visible: true, blinkVisible: true, blend: "difference", color: null,
  } });
  assert.equal(screenRenderFixture.pixel.format, "bgra8");
  assert.equal(screenRenderFixture.pixel.alpha, "premultiplied");
  assert.equal(screenRenderFixture.glyphs[0].fontRuns, 2);
  assert.equal(screenRenderFixture.glyphs[0].foreground, "#ff0000");
  assert.deepEqual(validateRenderMetadata(render, frame, cursor,
    [{ row: 0, col: 0, grapheme: "A़" }]), { result: "declared", frame: "1/2/3" });
  assert.throws(() => validateRenderMetadata({ ...render,
    frame: { generation: 1, raster: 2, sequence: 4 } }, frame, cursor), /different frame/);
  assert.throws(() => validateRenderMetadata({ ...render,
    grid: { ...render.grid, origin: { x: 4, y: 0 } } }, frame, cursor), /grid is outside/);
  assert.throws(() => validateRenderMetadata({ ...render,
    pixel: { ...render.pixel, format: "rgba8" } }, frame, cursor), /pixel format/);
  assert.deepEqual(rasterizeCellBounds({ x: 1.25, y: -0.25, width: 2.5, height: 3.5 }, 4, 6),
    { x: 1, y: 0, width: 3, height: 4 });
  assert.deepEqual(rasterizeCellBounds({ x: 5.5, y: 1, width: 1, height: 2 }, 4, 6),
    { x: 4, y: 1, width: 0, height: 2 });
  assert.throws(() => validateRenderMetadata({ ...render,
    glyphs: [{ ...render.glyphs[0], bounds: { x: 1, y: 1, width: 0, height: 3 } }] }, frame, cursor),
  /glyph ink rectangle is invalid/);
  assert.throws(() => validateRenderMetadata({ ...render, glyphs: [] }, frame, cursor,
    [{ row: 0, col: 0, grapheme: "ㅏ" }]), /glyph bounds are missing/);
  assert.deepEqual(validateRenderMetadata(null, frame, cursor),
    { result: "no-proof", reason: "renderer-metadata-unavailable" });
  assert.throws(() => validateRenderMetadata(undefined, frame, cursor), /must be null or an object/);
  assert.throws(() => validateRenderMetadata({ frame }, frame, cursor), /renderer pixel dimensions are invalid/);
});

testWithTimeout("producer-shaped overlay metadata preserves effective colors and blink-off cursor state", () => {
  const cursor = { shape: "beam", focused: true, visible: true, blinkVisible: false };
  assert.deepEqual(validateRenderMetadata(overlayRenderFixture, overlayRenderFixture.frame, cursor,
    [{ row: 0, col: 0, grapheme: "한" }, { row: 0, col: 2, grapheme: "Z" }]),
  { result: "declared", frame: "1/3/5" });
  assert.equal(overlayRenderFixture.cursor.rect, null);
  assert.equal(overlayRenderFixture.cursor.color, null);
  assert.equal(overlayRenderFixture.glyphs[0].width, 2);
  assert.deepEqual([overlayRenderFixture.glyphs[0].foreground, overlayRenderFixture.glyphs[0].background],
    ["#d0d0d0", "#808080"]);
  assert.deepEqual([overlayRenderFixture.glyphs[1].foreground, overlayRenderFixture.glyphs[1].background],
    ["#0000ff", "#ff0000"]);
  assert.equal(overlayRenderFixture.glyphs.some((glyph) => glyph.row === 0 && glyph.col === 1), false,
    "wide glyph continuation has no duplicate glyph record");

  const malformed = { ...overlayRenderFixture, glyphs: [
    { ...overlayRenderFixture.glyphs[0], foreground: "red" },
  ] };
  assert.throws(() => measureRenderedCell(null, null, malformed, {
    frame: overlayRenderFixture.frame, row: 0, col: 0, grapheme: "한", marked: true, cursor,
  }, { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 }),
  /renderer effective glyph colors are invalid/);

  const drawnCursor = { ...overlayRenderFixture, cursor: { ...overlayRenderFixture.cursor,
    rect: { x: 8.5, y: 0, width: 1, height: 6 }, blinkVisible: true, color: "#d0d0d0" } };
  assert.deepEqual(validateRenderMetadata(drawnCursor, drawnCursor.frame,
    { shape: "beam", focused: true, visible: true, blinkVisible: true }),
  { result: "declared", frame: "1/3/5" });
  const hiddenCursor = { ...overlayRenderFixture, cursor: { ...overlayRenderFixture.cursor,
    shape: "hidden", visible: true, blinkVisible: true } };
  assert.deepEqual(validateRenderMetadata(hiddenCursor, hiddenCursor.frame,
    { shape: "hidden", focused: true, visible: true, blinkVisible: true }),
  { result: "declared", frame: "1/3/5" });
  assert.throws(() => validateRenderMetadata({ ...overlayRenderFixture, cursor: {
    ...overlayRenderFixture.cursor, rect: { x: 8, y: 0, width: 1, height: 6 }, color: "#d0d0d0",
  } }, overlayRenderFixture.frame, cursor), /undrawn cursor must not report rectangle or color/);
  assert.throws(() => validateRenderMetadata({ ...hiddenCursor, cursor: {
    ...hiddenCursor.cursor, rect: { x: 8, y: 0, width: 1, height: 6 }, color: "#d0d0d0",
  } }, hiddenCursor.frame,
  { shape: "hidden", focused: true, visible: true, blinkVisible: true }),
  /undrawn cursor must not report rectangle or color/);
  assert.throws(() => validateRenderMetadata({ ...overlayRenderFixture, cursor: {
    ...overlayRenderFixture.cursor, rect: { x: 12, y: 0, width: 1, height: 6 },
  } }, overlayRenderFixture.frame, cursor), /cursor rectangle is outside/);
  assert.throws(() => validateRenderMetadata({ ...overlayRenderFixture, cursor: {
    ...overlayRenderFixture.cursor, blend: "difference", color: "#d0d0d0",
  } }, overlayRenderFixture.frame, cursor), /difference cursor must not claim a color/);
});

testWithTimeout("wide glyph measurement uses its two-cell fractional bounds and clips raster intersection", () => {
  const render = overlayRenderFixture;
  const glyph = render.glyphs[0];
  const cursor = { shape: "beam", focused: true, visible: true, blinkVisible: false };
  const pixels = new Uint8Array(12 * 6 * 4).fill(255);
  premultipliedPixel(pixels, 2, 2, [208, 208, 208], 128, 12);
  for (let x = 0; x < 8; x++) pixel(pixels, x, 5, [208, 208, 208], 12);
  const capture = { width: 12, height: 6, bytesPerRow: 48, data: pixels, format: "BGRA8",
    alpha: "premultiplied-first", colorSpace: "sRGB", scaleFactor: 1,
    screenRect: { x: 0, y: 0, width: 12, height: 6 }, contentRect: { x: 0, y: 0, width: 12, height: 6 } };
  const target = { frame: render.frame, row: glyph.row, col: glyph.col, grapheme: glyph.grapheme,
    marked: true, cursor };
  const criteria = { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 };
  const measured = measure(capture, render, target, criteria);
  assert.equal(measured.result, "measured");
  assert.equal(measured.underlined, true);
  assert.deepEqual(rasterizeCellBounds(glyph.bounds, 8, 6), { x: 0, y: 0, width: 8, height: 4 });
  assert.deepEqual(rasterizeCellBounds(glyph.underline.rect, 8, 6), { x: 0, y: 5, width: 8, height: 1 });
  assert.throws(() => validateRenderMetadata({ ...render, glyphs: [
    { ...glyph, col: 2 },
  ] }, render.frame, cursor), /renderer glyph identity is invalid/);
  assert.deepEqual(rasterizeCellBounds({ x: 8.25, y: 1, width: 0.5, height: 1 }, 8, 6),
    { x: 8, y: 1, width: 0, height: 1 });
  assert.deepEqual(rasterizeCellBounds({ x: 8.25, y: 5, width: 0.5, height: 1 }, 8, 6),
    { x: 8, y: 5, width: 0, height: 1 });
});

testWithTimeout("raw glyph ink bounds preserve signed overhang and clip only to the raster", () => {
  const render = structuredClone(overlayRenderFixture);
  render.grid.cols = 3;
  render.glyphs = [render.glyphs[0]];
  const glyph = render.glyphs[0];
  glyph.col = 1;
  const originalBounds = structuredClone(glyph.bounds);
  const originalUnderline = structuredClone(glyph.underline.rect);
  assert.deepEqual(originalBounds, { x: -1.25, y: -0.25, width: 10.5, height: 3.5 });
  assert.deepEqual(originalUnderline, { x: -0.5, y: 5, width: 9.25, height: 1 });
  const cursor = { shape: "beam", focused: true, visible: true, blinkVisible: false };
  assert.deepEqual(validateRenderMetadata(render, render.frame, cursor,
    [{ row: 0, col: 1, grapheme: "한" }]), { result: "declared", frame: "1/3/5" });
  assert.deepEqual(glyph.bounds, originalBounds, "raw producer bounds are not clamped or rewritten");
  assert.deepEqual(rasterizeCellBounds({ x: render.grid.origin.x + glyph.col * render.grid.cellWidth + glyph.bounds.x,
    y: render.grid.origin.y + glyph.row * render.grid.cellHeight + glyph.bounds.y,
    width: glyph.bounds.width, height: glyph.bounds.height }, 12, 6),
  { x: 2, y: 0, width: 10, height: 4 });
  assert.deepEqual(rasterizeCellBounds({ x: render.grid.origin.x + glyph.col * render.grid.cellWidth +
    glyph.underline.rect.x, y: render.grid.origin.y + glyph.row * render.grid.cellHeight +
    glyph.underline.rect.y, width: glyph.underline.rect.width, height: glyph.underline.rect.height }, 12, 6),
  { x: 3, y: 5, width: 9, height: 1 });

  const outside = structuredClone(render);
  outside.glyphs[0].bounds = { x: 20.25, y: 1, width: 0.5, height: 1 };
  assert.deepEqual(validateRenderMetadata(outside, outside.frame, cursor,
    [{ row: 0, col: 1, grapheme: "한" }]), { result: "declared", frame: "1/3/5" });
  const bytesPerRow = 164;
  const pixels = new Uint8Array(bytesPerRow * 20).fill(255);
  pixel(pixels, 25, 14, [208, 208, 208], 40, bytesPerRow);
  for (let x = 25; x < 35; x++) pixel(pixels, x, 17, [208, 208, 208], 40, bytesPerRow);
  const capture = { width: 40, height: 20, bytesPerRow, data: pixels, format: "BGRA8",
    alpha: "premultiplied-first", colorSpace: "sRGB", scaleFactor: 2,
    screenRect: { x: 90, y: 35, width: 20, height: 10 },
    contentRect: { x: 1, y: 1, width: 18, height: 8 } };
  const source = { ...raster(12, 6, 3, 1, new Uint8Array(12 * 6 * 4)), scale: 2,
    screenBounds: { x: 100, y: 40, width: 6, height: 3 } };
  const mapped = mapCaptureRaster(capture, source);
  assert.deepEqual(mapped.origin, { x: -22, y: -12 });
  assert.equal(mapped.bytes.length, 40 * 20 * 4, "capture padding is removed without changing pixel order");
  assert.deepEqual(measureRenderedCell(capture, source, render, { frame: render.frame, row: 0, col: 1,
    grapheme: "한", marked: true, cursor },
  { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 }),
  { result: "measured", glyphPixels: 1, underlineCoverage: 1, underlined: true, glyphPresent: true });
  assert.deepEqual(measureRenderedCell(capture, source, outside, { frame: outside.frame, row: 0, col: 1,
    grapheme: "한", marked: true, cursor },
  { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 }),
  { result: "no-proof", reason: "same-frame-glyph-ink-outside-raster" });
  const outsideUnderline = structuredClone(render);
  outsideUnderline.glyphs[0].underline.rect = { x: 20, y: 5, width: 1, height: 1 };
  assert.deepEqual(measureRenderedCell(capture, source, outsideUnderline, { frame: outsideUnderline.frame, row: 0, col: 1,
    grapheme: "한", marked: true, cursor },
  { colorDistance: 32, minimumGlyphPixels: 1, minimumUnderlineCoverage: 0.75 }),
  { result: "no-proof", reason: "same-frame-underline-outside-raster" });
  for (const bounds of [
    { x: Number.NaN, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 },
  ]) {
    assert.throws(() => validateRenderMetadata({ ...render, glyphs: [
      { ...glyph, bounds }, ...render.glyphs.slice(1),
    ] }, render.frame, cursor), /renderer glyph ink rectangle is invalid/);
  }
  for (const rect of [
    { x: Number.NaN, y: 5, width: 1, height: 1 },
    { x: -0.5, y: 5, width: 0, height: 1 },
  ]) {
    assert.throws(() => validateRenderMetadata({ ...render, glyphs: [
      { ...glyph, underline: { rect } },
    ] }, render.frame, cursor), /renderer glyph underline rectangle is invalid/);
  }
});

testWithTimeout("rendered-cell predicate uses actual glyph and underline rectangles with cursor inversion", () => {
  const render = renderFixture();
  const criteria = { colorDistance: 32, minimumGlyphPixels: 2, minimumUnderlineCoverage: 0.75 };
  const target = { frame: render.frame, row: 0, col: 0, grapheme: "ㅏ", marked: true,
    cursor: { shape: "beam", focused: true, visible: false, blinkVisible: false } };
  const complete = compositionRaster();
  assert.equal(measure(complete, render, target, criteria).result, "measured");
  assert.deepEqual(measure(complete, null, target, criteria),
    { result: "no-proof", reason: "renderer-metadata-unavailable" });
  assert.throws(() => measure(complete, undefined, target, criteria),
    /must be null or an object/);
  const unsupportedCursor = { ...render, cursor: { rect: { x: 1, y: 1, width: 1, height: 1 }, shape: "beam",
    focused: true, visible: true, blinkVisible: true, blend: "normal", color: "#d0d0d0", border: 0 } };
  assert.deepEqual(measure(complete, unsupportedCursor,
    { ...target, cursor: { ...target.cursor, visible: true, blinkVisible: true } }, criteria),
    { result: "no-proof", reason: "glyph-overlaps-unsupported-cursor" });
  assert.throws(() => measure(complete, { ...render,
    frame: { ...render.frame, sequence: 4 } }, target, criteria), /different frame/);
  assert.throws(() => measure(complete, render,
    { ...target, cursor: { ...target.cursor, visible: undefined } }, criteria), /cursor state is incomplete/);
  assert.throws(() => measure(complete, render,
    { row: 0, col: 0, grapheme: "ㅏ", marked: true }, criteria), /frame-bound terminal cursor state/);

  const lowerGlyphStroke = compositionRaster({ underline: false });
  pixel(lowerGlyphStroke.bytes, 0, 5, [0, 0, 0], 12);
  pixel(lowerGlyphStroke.bytes, 1, 5, [0, 0, 0], 12);
  const lowerStrokeResult = measure(lowerGlyphStroke, render, target, criteria);
  assert.equal(lowerStrokeResult.glyphPixels, 2);
  assert.equal(lowerStrokeResult.glyphPresent, true);
  assert.equal(lowerStrokeResult.underlineCoverage, 0.5);
  assert.equal(lowerStrokeResult.underlined, false);
  assert.equal(lowerStrokeResult.result, "failed");

  const wrongRange = compositionRaster({ wrongUnderline: true });
  assert.equal(measure(wrongRange, render, target, criteria).underlined, false);
  assert.equal(measure(complete, render, { ...target, marked: false }, criteria).result, "failed");

  const blankCursor = compositionRaster({ glyph: false, underline: false });
  for (let y = 0; y < 6; y++) for (let x = 0; x < 4; x++) pixel(blankCursor.bytes, x, y, [0, 0, 0], 12);
  const blockCursor = { ...render, cursor: { rect: { x: 0, y: 0, width: 4, height: 6 }, shape: "block",
    focused: true, visible: true, blinkVisible: true, blend: "difference", color: null, border: 0 } };
  assert.equal(measure(blankCursor, blockCursor, { ...target, marked: false,
    cursor: { ...target.cursor, shape: "block", visible: true, blinkVisible: true } }, criteria).result,
    "failed");

  const blockOverUnderline = { ...render, cursor: { rect: { x: 0, y: 5, width: 4, height: 1 },
    shape: "block", focused: true, visible: true, blinkVisible: true, blend: "difference", color: null, border: 0 } };
  const invertedUnderline = compositionRaster();
  for (let x = 0; x < 4; x++) pixel(invertedUnderline.bytes, x, 5, [255, 255, 255], 12);
  assert.equal(measure(invertedUnderline, blockOverUnderline,
    { ...target, cursor: { ...target.cursor, shape: "block", visible: true, blinkVisible: true } },
    criteria).result, "measured");
});
