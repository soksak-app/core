import assert from "node:assert/strict";
import test from "node:test";

import {
  compositionFrameCandidates,
  measureRenderedCell,
  rasterizeCellBounds,
  validateRenderMetadata,
} from "./terminal-ime-visual.mjs";

function testWithTimeout(name, body) {
  test(name, { timeout: 2000 }, body);
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
    screenRect: source.screenBounds, contentRect: { x: 0, y: 0, width: source.width, height: source.height },
    data: source.data };
}

function blank() {
  return new Uint8Array(4 * 6 * 4).map((_, index) => index % 4 === 3 ? 255 : 255);
}

function pixel(data, x, y, color) {
  const offset = (y * 4 + x) * 4;
  data.set([color[2], color[1], color[0], 255], offset);
}

function compositionRaster({ glyph = true, underline = true, wrongUnderline = false } = {}) {
  const data = blank();
  if (glyph) {
    pixel(data, 1, 1, [0, 0, 0]);
    pixel(data, 2, 2, [0, 0, 0]);
  }
  if (underline) for (let x = 0; x < 4; x++) pixel(data, x, wrongUnderline ? 4 : 5, [0, 0, 0]);
  return { width: 4, height: 6, bytes: data };
}

testWithTimeout("ROI candidate set includes the exact target and preserves duplicate identity ambiguity", () => {
  const target = { generation: 1, raster: 2, sequence: 3 };
  const data = blank();
  const sourceRaster = raster(4, 6, 1, 1, data);
  const capture = captureFor(sourceRaster);
  const state = { document: "ㅏ", preedit: "ㅏ", focus: true };
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
  const source = { frame: sourceFrame, raster: sourceRaster, state: { frame: sourceFrame, semantic: { document: "wrong" } } };
  const result = compositionFrameCandidates({ targetFrame: target, capture, cell: { row: 0, column: 0 },
    expectedState: { document: "ㅏ" }, sources: [source] });
  assert.equal(result.result, "no-proof");
  assert.deepEqual(result.reasons, ["target-frame-not-in-roi-candidates", "candidate-semantic-state-differs"]);
  const fractionalRaster = raster(5, 6, 2, 1, new Uint8Array(5 * 6 * 4));
  assert.throws(() => compositionFrameCandidates({ targetFrame: target, capture: captureFor(fractionalRaster),
    cell: { row: 0, column: 0 }, expectedState: {},
    sources: [{ frame: target, raster: fractionalRaster, state: { frame: target, semantic: {} } }] }),
  /integer cell-grid geometry is required/);
});

testWithTimeout("complete input and guard cell bytes reject an extra glyph outside the expected document", () => {
  const target = { generation: 1, raster: 2, sequence: 3 };
  const captureData = new Uint8Array(12 * 6 * 4).fill(255);
  const sourceData = captureData.slice();
  pixel(sourceData, 9, 2, [0, 0, 0]);
  const sourceRaster = raster(12, 6, 3, 1, sourceData);
  const capture = captureFor({ ...sourceRaster, data: captureData });
  const state = { document: "ㅏ" };
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
  const semantic = { document: "ㅏ" };
  const result = compositionFrameCandidates({ targetFrame: frame, capture, cells: [{ row: 0, column: 0 }],
    expectedState: semantic, sources: [{ frame, raster: sourceRaster, state: { frame, semantic } }] });
  assert.equal(result.result, "candidate-set");
  assert.deepEqual(result.identities, ["2/4/9"]);
});

testWithTimeout("renderer geometry is frame-bound and rejects unsupported pixel layouts", () => {
  const frame = { generation: 1, raster: 2, sequence: 3 };
  const cursor = { shape: "block", focused: true, visible: true, blinkVisible: true };
  const render = {
    frame,
    pixel: { width: 4, height: 6, bytesPerRow: 16, format: "BGRA8", alpha: "premultiplied-first",
      colorSpace: "sRGB", origin: "top-left" },
    grid: { rows: 1, cols: 1, cellWidth: 4, cellHeight: 6, origin: { x: 0, y: 0 } },
    font: { family: "fixture", size: 6, ascent: 4, descent: 1, leading: 1 },
    underline: { rect: { x: 0, y: 5, width: 4, height: 1 }, colorSource: "cell.foregroundAfterInverse" },
    glyphs: [{ row: 0, col: 0, grapheme: "ㅏ", bounds: { x: 1, y: 1, width: 2, height: 3 } }],
    cursor: { rect: { x: 0, y: 0, width: 1, height: 1 }, shape: "block", focused: true,
      visible: true, blinkVisible: true, blend: "difference" },
  };
  assert.deepEqual(validateRenderMetadata(render, frame, cursor, [{ row: 0, col: 0, grapheme: "ㅏ" }]),
    { result: "declared", frame: "1/2/3" });
  assert.throws(() => validateRenderMetadata({ ...render,
    frame: { generation: 1, raster: 2, sequence: 4 } }, frame, cursor), /different frame/);
  assert.throws(() => validateRenderMetadata({ ...render,
    grid: { ...render.grid, origin: { x: 4, y: 0 } } }, frame, cursor), /grid is outside/);
  assert.throws(() => validateRenderMetadata({ ...render,
    pixel: { ...render.pixel, format: "RGBA8" } }, frame, cursor), /must be BGRA8/);
  assert.deepEqual(rasterizeCellBounds({ x: 1.25, y: -0.25, width: 2.5, height: 3.5 }, 4, 6),
    { x: 1, y: 0, width: 3, height: 4 });
  assert.throws(() => rasterizeCellBounds({ x: 5.5, y: 1, width: 1, height: 2 }, 4, 6), /covers no cell pixels/);
  assert.throws(() => validateRenderMetadata({ ...render,
    glyphs: [{ ...render.glyphs[0], bounds: { x: 1, y: 1, width: 0, height: 3 } }] }, frame, cursor),
  /glyph ink rectangle is invalid/);
  assert.throws(() => validateRenderMetadata({ ...render, glyphs: [] }, frame, cursor,
    [{ row: 0, col: 0, grapheme: "ㅏ" }]), /glyph bounds are missing/);
  assert.deepEqual(validateRenderMetadata(null, frame, cursor),
    { result: "no-proof", reason: "renderer-metadata-missing" });
});

testWithTimeout("rendered-cell predicate uses actual glyph and underline rectangles with cursor inversion", () => {
  const render = {
    frame: { generation: 1, raster: 2, sequence: 3 },
    grid: { cellWidth: 4, cellHeight: 6, origin: { x: 0, y: 0 } },
    glyphs: [{ row: 0, col: 0, grapheme: "ㅏ", bounds: { x: 1.25, y: 1.25, width: 1.5, height: 2 } }],
    underline: { rect: { x: 0, y: 5, width: 4, height: 1 }, colorSource: "cell.foregroundAfterInverse" },
    cursor: { rect: { x: 0, y: 0, width: 0, height: 0 }, shape: "beam", visible: false, blinkVisible: false,
      blend: "normal" },
  };
  const colors = { foreground: [0, 0, 0], background: [255, 255, 255] };
  const criteria = { colorDistance: 32, minimumGlyphPixels: 2, minimumUnderlineCoverage: 0.75 };
  const target = { frame: render.frame, row: 0, col: 0, grapheme: "ㅏ", marked: true };
  const complete = compositionRaster();
  assert.equal(measureRenderedCell(complete, render, target, colors, criteria).result, "measured");
  assert.deepEqual(measureRenderedCell(complete, null, target, colors, criteria),
    { result: "no-proof", reason: "frame-bound-renderer-state-missing" });
  const unsupportedCursor = { ...render, cursor: { rect: { x: 1, y: 1, width: 1, height: 1 }, shape: "beam",
    visible: true, blinkVisible: true, blend: "normal" } };
  assert.deepEqual(measureRenderedCell(complete, unsupportedCursor, target, colors, criteria),
    { result: "no-proof", reason: "glyph-overlaps-unsupported-cursor" });
  assert.throws(() => measureRenderedCell(complete, { ...render,
    frame: { ...render.frame, sequence: 4 } }, target, colors, criteria), /frames differ/);
  assert.deepEqual(measureRenderedCell(complete, render, { row: 0, col: 0, grapheme: "ㅏ", marked: true }, colors,
    criteria), { result: "no-proof", reason: "frame-bound-renderer-state-missing" });

  const lowerGlyphStroke = compositionRaster({ underline: false });
  pixel(lowerGlyphStroke.bytes, 0, 5, [0, 0, 0]);
  pixel(lowerGlyphStroke.bytes, 1, 5, [0, 0, 0]);
  assert.equal(measureRenderedCell(lowerGlyphStroke, render, target, colors, criteria).result, "failed");

  const wrongRange = compositionRaster({ wrongUnderline: true });
  assert.equal(measureRenderedCell(wrongRange, render, target, colors, criteria).underlined, false);
  assert.equal(measureRenderedCell(complete, render, { ...target, marked: false }, colors, criteria).result, "failed");

  const blankCursor = compositionRaster({ glyph: false, underline: false });
  for (let y = 0; y < 6; y++) for (let x = 0; x < 4; x++) pixel(blankCursor.bytes, x, y, [0, 0, 0]);
  const blockCursor = { ...render, cursor: { rect: { x: 0, y: 0, width: 4, height: 6 }, shape: "block",
    visible: true, blinkVisible: true, blend: "difference" } };
  assert.equal(measureRenderedCell(blankCursor, blockCursor, { ...target, marked: false }, colors, criteria).result,
    "failed");
});
