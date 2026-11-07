// A later, independently verified reference supplies expected pixels, never
// the model state or frame identity of the earlier measured captures.
import assert from "node:assert/strict";
import { compositionFrameCandidates, measureRenderedCell, validateRenderMetadata } from "./activation/terminal-ime-visual.mjs";

function tuple(frame, label) {
  assert.ok(frame && ["generation", "raster", "sequence"].every((key) =>
    /^(?:[1-9]\d*)$/.test(String(frame[key])) &&
    (typeof frame[key] === "string" || Number.isSafeInteger(frame[key]))), `${label}: missing or invalid frame tuple`);
  return [frame.generation, frame.raster, frame.sequence].map(String).join("/");
}

function rectangle(rect, label) {
  assert.ok(rect && ["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key])) &&
    rect.width > 0 && rect.height > 0, `${label}: missing region geometry`);
  return rect;
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Returns the earliest normal capture with the verified complete glyph-and-guard pixels after a different anchor. */
export function firstTerminalReferenceContentFrame({ reference, frames, anchorFrameIndex }) {
  assert.ok(reference && ["terminal", "term"].includes(reference.plugin), "terminal reference plugin is invalid");
  const { source, screen, cursor, expected, region, issuedArtifact, identityRow } = reference;
  const key = tuple(screen?.frame, "reference screen");
  for (const [label, frame] of [["source", source?.frame], ["cursor", cursor?.frame],
    ["render", source?.render?.frame], ["cursor render", cursor?.render?.frame],
    ["issued artifact", issuedArtifact], ["decoded identity", identityRow?.identity]]) {
    assert.equal(tuple(frame, `reference ${label}`), key, `reference ${label} belongs to another frame`);
  }
  assert.deepEqual(cursor.render, source.render, "reference cursor and source render differ");
  assert.ok(typeof reference.surface === "string" && reference.surface.length > 0 && reference.name === "view" &&
    typeof reference.regionToken === "string" && reference.regionToken.length > 0, "reference region ownership is missing");
  assert.equal(source.regionToken, reference.regionToken, "reference source region differs");
  assert.equal(issuedArtifact.regionToken, reference.regionToken, "reference issued region differs");
  assert.equal(identityRow.region, reference.regionToken, "reference decoded region differs");
  assert.equal(identityRow.status, "matched", "reference identity was not matched");
  assert.equal(identityRow.reason, null, "reference identity has a rejection reason");
  const raster = source.raster;
  const render = source.render;
  validateRenderMetadata(render, screen.frame, cursor);
  assert.equal(render.pixel.width, raster.width, "reference renderer width differs");
  assert.equal(render.pixel.height, raster.height, "reference renderer height differs");
  assert.equal(render.pixel.bytesPerRow, raster.bytesPerRow, "reference renderer stride differs");
  assert.deepEqual(raster.grid, { rows: render.grid.rows, cols: render.grid.cols,
    cellWidth: render.grid.cellWidth, cellHeight: render.grid.cellHeight, x: render.grid.origin.x, y: render.grid.origin.y },
  "reference renderer grid differs from source geometry");
  for (const [field, value] of Object.entries({ width: raster.width, height: raster.height, stride: raster.bytesPerRow,
    scale: raster.scale, pixelFormat: raster.format, alpha: raster.alpha, colorSpace: raster.colorSpace, byteCount: raster.data.byteLength })) {
    assert.equal(issuedArtifact[field], value, `reference issued artifact ${field} differs from source`);
  }
  assert.ok(expected && typeof expected.text === "string" && expected.text.trim().length > 0 &&
    Number.isInteger(expected.row) && expected.row >= 0 && Number.isInteger(expected.startColumn) && expected.startColumn > 0,
  "reference expected glyph span is invalid");
  assert.ok(Array.isArray(screen.rows) && screen.rows.length === raster.grid.rows &&
    screen.rows.every(Array.isArray), "reference screen rows are missing");
  const row = screen.rows[expected.row];
  assert.ok(row, "reference expected screen row is missing");
  const positioned = [];
  let column = 0;
  for (const cell of row) {
    assert.ok(Number.isInteger(cell.width) && cell.width >= 0 && (cell.ch === undefined || typeof cell.ch === "string"),
      "reference screen cell is invalid");
    if (cell.width > 0) positioned.push({ column, cell });
    column += cell.width;
  }
  assert.equal(column, raster.grid.cols, "reference screen row width differs from renderer grid");
  let text = "";
  let end = expected.startColumn;
  const cells = [];
  const glyphs = [];
  for (const entry of positioned.filter((entry) => entry.column >= expected.startColumn)) {
    if (text.length >= expected.text.length) break;
    assert.equal(entry.column, end, "reference expected glyph span is discontinuous");
    const grapheme = entry.cell.ch ?? " ";
    text += grapheme;
    for (let offset = 0; offset < entry.cell.width; offset++) cells.push({ row: expected.row, column: end + offset });
    if (grapheme.trim()) glyphs.push({ row: expected.row, col: end, grapheme });
    end += entry.cell.width;
  }
  assert.equal(text, expected.text, "reference screen does not contain the complete expected text");
  assert.ok(glyphs.length > 0, "reference contains no expected glyphs");
  assert.deepEqual(expected.guards, [{ row: expected.row, column: expected.startColumn - 1 }, { row: expected.row, column: end }],
    "reference requires complete adjacent guard cells");
  assert.ok(end < raster.grid.cols, "reference trailing guard is outside the grid");
  cells.push(...expected.guards);
  validateRenderMetadata(render, screen.frame, cursor, glyphs);
  for (const glyph of glyphs) {
    const cell = positioned.find((entry) => entry.column === glyph.col).cell;
    const rendered = render.glyphs.filter((entry) => entry.row === glyph.row && entry.col === glyph.col);
    assert.equal(rendered.length, 1, "reference glyph metadata is missing or duplicated");
    assert.equal(rendered[0].width, cell.width, "reference glyph width differs from semantic screen cell");
  }
  const qr = rectangle(issuedArtifact.roi, "reference QR");
  for (const cell of cells) {
    assert.ok(!overlaps(qr, { x: raster.grid.x + cell.column * raster.grid.cellWidth,
      y: raster.grid.y + cell.row * raster.grid.cellHeight, width: raster.grid.cellWidth, height: raster.grid.cellHeight }),
    "reference QR overlaps a glyph or guard cell");
  }
  const semantic = { document: text, compose: { text: "", markedRange: null, selectedRange: null },
    cursor: { row: cursor.row, col: cursor.col, focused: cursor.focused, preedit: cursor.preedit },
    geometry: { rows: raster.grid.rows, cols: raster.grid.cols, cellWidth: raster.grid.cellWidth,
      cellHeight: raster.grid.cellHeight, origin: { x: raster.grid.x, y: raster.grid.y } } };
  const projectedSource = (placement) => {
    assert.ok(placement && placement.surface === reference.surface && placement.name === reference.name &&
      placement.regionToken === reference.regionToken, "capture region ownership differs from reference");
    const rect = rectangle(placement.rectPt, "capture region");
    assert.equal(rect.width * raster.scale, raster.width, "capture region width differs from reference geometry");
    assert.equal(rect.height * raster.scale, raster.height, "capture region height differs from reference geometry");
    return { frame: source.frame, raster: { ...raster, screenBounds: rect }, state: { frame: source.frame, semantic } };
  };
  const matches = (capture, placement) => compositionFrameCandidates({ targetFrame: source.frame, capture,
    sources: [projectedSource(placement)], cells, expectedState: semantic }).result === "candidate-set";
  assert.deepEqual(rectangle(region?.rectPt, "reference region"), raster.screenBounds,
    "reference region geometry differs from retained source");
  const sourceROI = { x: (reference.capture.contentRect.x + region.rectPt.x - reference.capture.screenRect.x) * raster.scale + qr.x,
    y: (reference.capture.contentRect.y + region.rectPt.y - reference.capture.screenRect.y) * raster.scale + qr.y,
    width: qr.width, height: qr.height };
  assert.deepEqual(identityRow.roi, sourceROI, "reference decoded QR geometry differs from issued source");
  assert.ok(matches(reference.capture, region), "reference source glyph and guard pixels differ from its capture");
  for (const glyph of glyphs) {
    const measured = measureRenderedCell(reference.capture, { ...raster, frame: source.frame }, render,
      { ...glyph, frame: source.frame, cursor, marked: false }, reference.criteria);
    assert.equal(measured.result, "measured", `reference glyph has no valid ink: ${measured.reason ?? measured.result}`);
  }
  assert.ok(Array.isArray(frames) && Number.isInteger(anchorFrameIndex) && anchorFrameIndex >= 0 && anchorFrameIndex < frames.length,
    "reference comparison requires a distinct anchor frame");
  const matched = frames.map((frame) => matches(frame.capture, frame.region));
  assert.ok(!matched[anchorFrameIndex], "anchor already contains the verified reference content");
  const frameIndex = matched.findIndex((value, index) => index > anchorFrameIndex && value);
  assert.ok(frameIndex >= 0, "no captured region contains the verified terminal reference pixels");
  return { frameIndex, proof: "verified-terminal-reference-exact-pixels", referenceFrame: source.frame };
}
