// A later, independently verified reference supplies expected pixels, never
// the model state or frame identity of the earlier measured captures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compositionFrameCandidates, compositionPixelProof, measureRenderedCell, validateRenderMetadata } from "./activation/terminal-ime-visual.mjs";
import { findFirstChangedSlotFrame } from "./view-frame-geometry.mjs";

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
function verifiedReferenceMatcher(reference) {
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
    pixelFormat: raster.format, alpha: raster.alpha, colorSpace: raster.colorSpace, byteCount: raster.data.byteLength })) {
    assert.equal(issuedArtifact[field], value, `reference issued artifact ${field} differs from source`);
  }
  // Issued identity manifest v1 has no scale field. Scale is proved by retained
  // source bounds/dimensions, native placement, and canonical capture mapping.
  assert.ok(!Object.hasOwn(issuedArtifact, "scale"), "reference issued artifact scale is not declared by manifest v1");
  assert.ok(expected && typeof expected.text === "string" && expected.text.trim().length > 0 &&
    Number.isInteger(expected.row) && expected.row >= 0 && Number.isInteger(expected.startColumn) && expected.startColumn >= 0,
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
  const atLeftEdge = expected.startColumn === 0;
  const guards = [atLeftEdge ? { row: expected.row, edge: "left", column: 0 } :
    { row: expected.row, column: expected.startColumn - 1 }, { row: expected.row, column: end }];
  assert.deepEqual(expected.guards, guards,
    "reference requires complete adjacent guard cells");
  assert.ok(end < raster.grid.cols, "reference trailing guard is outside the grid");
  // A viewport edge is a geometric guard, never a crop of a nonexistent cell.
  cells.push(...guards.filter((guard) => guard.edge === undefined));
  // This prompt proof has no cursor-bearing cells. Even an invisible cursor
  // at these coordinates would require independently verified blink variants.
  const cursorRect = render.cursor?.rect;
  for (const cell of cells) {
    const cellRect = { x: raster.grid.x + cell.column * raster.grid.cellWidth,
      y: raster.grid.y + cell.row * raster.grid.cellHeight,
      width: raster.grid.cellWidth, height: raster.grid.cellHeight };
    assert.ok(!(cursor.row === cell.row && cursor.col === cell.column) &&
      !(cursorRect && overlaps(cursorRect, cellRect)),
    "reference cursor overlaps a complete glyph or guard cell");
  }
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
  const projectedSource = (rectPt, clipRectPt) => {
    const rect = rectangle(rectPt, "capture region");
    assert.equal(rect.width * raster.scale, raster.width, "capture region width differs from reference geometry");
    assert.equal(rect.height * raster.scale, raster.height, "capture region height differs from reference geometry");
    if (atLeftEdge) {
      const clip = rectangle(clipRectPt, "capture native viewport clip");
      const gridLeft = rect.x + raster.grid.x / raster.scale;
      const rowTop = rect.y + (raster.grid.y + expected.row * raster.grid.cellHeight) / raster.scale;
      const rowBottom = rowTop + raster.grid.cellHeight / raster.scale;
      const guardRight = gridLeft + (end + 1) * raster.grid.cellWidth / raster.scale;
      assert.equal(clip.x, gridLeft, "reference left edge differs from native viewport clip boundary");
      assert.ok(clip.y <= rowTop && clip.y + clip.height >= rowBottom &&
        clip.x + clip.width >= guardRight, "native viewport clip truncates a complete glyph or guard cell");
    }
    return { frame: source.frame, raster: { ...raster, screenBounds: rect }, state: { frame: source.frame, semantic } };
  };
  const matchesMeasuredLayout = (capture, rectPt, clipRectPt) => compositionFrameCandidates({ targetFrame: source.frame, capture,
    sources: [projectedSource(rectPt, clipRectPt)], cells, expectedState: semantic }).result === "candidate-set";
  const matches = (capture, placement) => {
    assert.ok(placement && placement.surface === reference.surface && placement.name === reference.name &&
      placement.regionToken === reference.regionToken, "capture region ownership differs from reference");
    return matchesMeasuredLayout(capture, placement.rectPt, placement.clipRectPt);
  };
  assert.deepEqual(rectangle(region?.rectPt, "reference region"), raster.screenBounds,
    "reference region geometry differs from retained source");
  const sourceROI = { x: (reference.capture.contentRect.x + region.rectPt.x - reference.capture.screenRect.x) * raster.scale + qr.x,
    y: (reference.capture.contentRect.y + region.rectPt.y - reference.capture.screenRect.y) * raster.scale + qr.y,
    width: qr.width, height: qr.height };
  assert.deepEqual(identityRow.roi, sourceROI, "reference decoded QR geometry differs from issued source");
  if (!matches(reference.capture, region)) {
    // Evidence only: the canonical matcher above remains the acceptance rule.
    // Report exact source/capture bytes at the identical selected coordinates.
    const capture = reference.capture;
    const differences = [];
    let differingPixels = 0;
    for (const cell of cells) {
      const sx = raster.grid.x + cell.column * raster.grid.cellWidth;
      const sy = raster.grid.y + cell.row * raster.grid.cellHeight;
      const cx = (capture.contentRect.x + region.rectPt.x - capture.screenRect.x) * raster.scale + sx;
      const cy = (capture.contentRect.y + region.rectPt.y - capture.screenRect.y) * raster.scale + sy;
      for (let y = 0; y < raster.grid.cellHeight; y++) for (let x = 0; x < raster.grid.cellWidth; x++) {
        const from = (sy + y) * raster.bytesPerRow + (sx + x) * 4;
        const to = (cy + y) * capture.bytesPerRow + (cx + x) * 4;
        const sourceBGRA = [...raster.data.subarray(from, from + 4)];
        const captureBGRA = [...capture.data.subarray(to, to + 4)];
        if (sourceBGRA.every((byte, index) => byte === captureBGRA[index])) continue;
        differingPixels++;
        if (differences.length < 12) differences.push({ cell, sourcePixel: { x: sx + x, y: sy + y },
          capturePixel: { x: cx + x, y: cy + y }, sourceBGRA, captureBGRA,
          deltaBGRA: captureBGRA.map((byte, index) => byte - sourceBGRA[index]),
          glyph: render.glyphs.find(glyph => glyph.row === cell.row && glyph.col === cell.column) ?? null });
      }
    }
    assert.fail(`reference source glyph and guard pixels differ from its capture: ${JSON.stringify({
      differingPixels, differences, source: { format: raster.format, alpha: raster.alpha,
        colorSpace: raster.colorSpace, scale: raster.scale, screenBounds: raster.screenBounds },
      capture: { format: capture.format, alpha: capture.alpha, colorSpace: capture.colorSpace,
        scaleFactor: capture.scaleFactor, screenRect: capture.screenRect, contentRect: capture.contentRect },
      region, issuedQR: qr, decodedQR: identityRow.roi })}`);
  }
  for (const glyph of glyphs) {
    const measured = measureRenderedCell(reference.capture, { ...raster, frame: source.frame }, render,
      { ...glyph, frame: source.frame, cursor, marked: false }, reference.criteria);
    assert.equal(measured.result, "measured", `reference glyph has no valid ink: ${measured.reason ?? measured.result}`);
  }
  return { matches, matchesMeasuredLayout,
    metricEvidence: (capture, rectPt) => ({ observedText: text, glyphCount: glyphs.length,
      span: { row: expected.row, startColumn: expected.startColumn, endColumn: end, viewportLeftEdge: atLeftEdge },
      ...compositionPixelProof({ capture, source: projectedSource(rectPt, { ...rectPt }).raster, cells }) }) };
}

/** Serializes proof only after revalidating its actual acquired reference and
 * independently reading the selected normal capture's complete cell bytes. */
export function createTerminalReferenceProof(reference, capture, rectPt, frame) {
  assert.ok(Number.isSafeInteger(reference.observationRequestId) && reference.observationRequestId > 0,
    "reference observation ownership is missing");
  assert.ok(reference.sourceArtifact, "reference retained source artifact ownership is missing");
  assert.equal(tuple(reference.sourceArtifact, "retained source artifact"), tuple(reference.screen.frame, "observed frame"),
    "retained source artifact belongs to another reference frame");
  assert.equal(frame?.surface, reference.surface, "metric frame belongs to another reference surface");
  assert.ok(Number.isSafeInteger(frame.frameIndex) && frame.frameIndex >= 0 &&
    Number.isSafeInteger(frame.frameCount) && frame.frameCount > frame.frameIndex &&
    Number.isFinite(frame.timeMs) && frame.timeMs >= 0, "reference metric capture ownership is invalid");
  const { metricEvidence } = verifiedReferenceMatcher(reference);
  const evidence = metricEvidence(capture, rectPt);
  const sourceSha256 = createHash("sha256").update(reference.source.raster.data).digest("hex");
  assert.equal(sourceSha256, reference.sourceArtifact.sha256, "reference source digest differs from its retained artifact");
  assert.equal(reference.source.raster.data.length, reference.sourceArtifact.byteCount, "reference source byte count differs from its retained artifact");
  const identity = value => ({ generation: value.generation, raster: value.raster, sequence: value.sequence });
  return { method: "terminal-reference-exact-pixels-v1", expected: reference.expected.text,
    observedText: evidence.observedText,
    observedTextSha256: createHash("sha256").update(evidence.observedText).digest("hex"),
    reference: { plugin: reference.plugin, observationRequestId: reference.observationRequestId,
      surface: reference.surface, name: reference.name, regionToken: reference.regionToken,
      frame: identity(reference.screen.frame), sourceFrame: identity(reference.source.frame),
      rendererFrame: identity(reference.source.render.frame), cursorFrame: identity(reference.cursor.frame),
      issuedFrame: identity(reference.issuedArtifact), decodedFrame: identity(reference.identityRow.identity),
      sourceRegionToken: reference.source.regionToken, issuedRegionToken: reference.issuedArtifact.regionToken,
      decodedRegionToken: reference.identityRow.region, sourceSha256,
      retainedSourceSha256: reference.sourceArtifact.sha256, sourceByteCount: reference.sourceArtifact.byteCount,
      glyphCount: evidence.glyphCount },
    match: { frameIndex: frame.frameIndex, frameCount: frame.frameCount, timeMs: frame.timeMs,
      span: evidence.span, cellCount: evidence.cellCount, byteCount: evidence.byteCount,
      sourceCellsSha256: evidence.sourceCellsSha256, capturedCellsSha256: evidence.capturedCellsSha256 } };
}

/** Verifies the acquired reference itself; makes no claim about earlier captures. */
export function verifyTerminalReference(reference) {
  verifiedReferenceMatcher(reference);
  return { proof: "verified-terminal-reference-acquisition" };
}

export function firstTerminalReferenceContentFrame({ reference, frames, anchorFrameIndex }) {
  const { matches } = verifiedReferenceMatcher(reference);
  assert.ok(Array.isArray(frames) && Number.isInteger(anchorFrameIndex) && anchorFrameIndex >= 0 && anchorFrameIndex < frames.length,
    "reference comparison requires a distinct anchor frame");
  const matched = frames.map((frame) => matches(frame.capture, frame.region));
  assert.ok(!matched[anchorFrameIndex], "anchor already contains the verified reference content");
  const frameIndex = matched.findIndex((value, index) => index > anchorFrameIndex && value);
  assert.ok(frameIndex >= 0, "no captured region contains the verified terminal reference pixels");
  return { frameIndex, proof: "verified-terminal-reference-exact-pixels", referenceFrame: reference.source.frame };
}


/** Layout has a different measured slot, not different prompt text. The caller
 * declares its target before recording; each placement comes only from that
 * capture's measured card/native slot. Reference IDs never identify old frames. */
export function firstTerminalReferenceLayoutFrame({ reference, target, frames, geometryFrames,
  beforeChangeTimeMs, slotInsetsPt, notBeforeTimeMs = beforeChangeTimeMs }) {
  assert.ok(target && typeof target.card === "string" && target.card &&
    typeof target.surface === "string" && target.surface, "layout recording target ownership is missing");
  assert.equal(reference.surface, target.surface, "reference belongs to another layout recording target");
  assert.ok(Array.isArray(frames) && frames.length === geometryFrames?.length,
    "layout captures and measured geometry coverage differ");
  assert.ok(Number.isFinite(notBeforeTimeMs), "layout reference timing boundary is missing");
  const transition = findFirstChangedSlotFrame(geometryFrames, { beforeChangeTimeMs, slotInsetsPt });
  const { matchesMeasuredLayout } = verifiedReferenceMatcher(reference);
  const candidates = transition.slotMatchFrameIndices.filter(index => geometryFrames[index].timeMs >= notBeforeTimeMs);
  assert.ok(candidates.length > 0, "layout has no captured declared-slot frame after its required boundary");
  const matched = candidates.map(index => {
    const capture = frames[index]?.capture;
    assert.ok(capture?.screenRect && capture.contentRect, "layout capture callback geometry is missing");
    const rect = geometryFrames[index].nativeRectPt;
    // Measured slot coordinates are relative to the captured window content.
    // screenRect is this callback's public global content-window placement.
    const rectPt = { x: capture.screenRect.x + rect.left, y: capture.screenRect.y + rect.top,
      width: rect.right - rect.left, height: rect.bottom - rect.top };
    return matchesMeasuredLayout(capture, rectPt, { ...rectPt });
  });
  const first = matched.indexOf(true);
  assert.ok(first >= 0, "no captured declared slot contains the verified terminal reference pixels");
  const capture = frames[candidates[first]].capture;
  const rect = geometryFrames[candidates[first]].nativeRectPt;
  const matchedRectPt = { x: capture.screenRect.x + rect.left, y: capture.screenRect.y + rect.top,
    width: rect.right - rect.left, height: rect.bottom - rect.top };
  return { matchedRectPt, frameIndex: candidates[first], geometryAnchorFrameIndex: transition.baselineFrameIndex,
    proof: "verified-terminal-reference-layout-exact-pixels", referenceFrame: reference.source.frame };
}


/** Startup/reopen/reclaim uses a physical different-content anchor in the
 * declared slot of the measured card. Old target pixels before that anchor
 * remain in the recording and cannot count as new content. */
export function firstTerminalReferenceStartFrame({ reference, target, frames, geometryFrames,
  anchorPresentedAtMs, targetRequestAtMs, slotInsetsPt, anchorNativeRectPt }) {
  assert.ok(target && typeof target.card === "string" && target.card &&
    typeof target.surface === "string" && target.surface, "startup target ownership is missing");
  assert.equal(reference.surface, target.surface, "reference belongs to another startup target surface");
  assert.ok(Array.isArray(frames) && frames.length > 0 && frames.length === geometryFrames?.length,
    "startup capture and measured geometry coverage differ");
  assert.ok(Number.isFinite(anchorPresentedAtMs) && Number.isFinite(targetRequestAtMs) &&
    targetRequestAtMs >= anchorPresentedAtMs, `startup anchor/request boundaries are missing or unordered: ${JSON.stringify({ anchorPresentedAtMs, targetRequestAtMs })}`);
  assert.ok(slotInsetsPt && ["left", "top", "right", "bottom"].every(edge =>
    Number.isFinite(slotInsetsPt[edge]) && slotInsetsPt[edge] >= 0), "startup declared slot geometry is missing");
  const native = rectangle(anchorNativeRectPt, "pre-open native applied anchor rectangle");
  const anchorPhaseIndex = geometryFrames.findIndex(frame => Number.isFinite(frame?.timeMs) &&
    frame.timeMs >= anchorPresentedAtMs && frame.timeMs <= targetRequestAtMs);
  assert.ok(anchorPhaseIndex >= 0, "recording has no measured frame in the pre-open anchor phase");
  const anchorCard = geometryFrames[anchorPhaseIndex]?.cardRectPt;
  assert.ok(anchorCard && ["left", "top", "right", "bottom"].every(edge => Number.isFinite(anchorCard[edge])),
    "pre-open anchor measured card geometry is missing");
  // Native placement already fits the CSS declaration inward to backing pixels.
  // Subtract only backing-aligned native/measured values, never CSS fractions
  // from pixel-measured card edges. The later reference supplies neither value.
  const nativeInsetsPt = { left: native.x - anchorCard.left, top: native.y - anchorCard.top,
    right: anchorCard.right - (native.x + native.width),
    bottom: anchorCard.bottom - (native.y + native.height) };
  assert.ok(Object.values(nativeInsetsPt).every(value => Number.isFinite(value) && value >= 0),
    "pre-open native anchor rectangle lies outside its measured card geometry");
  const { matchesMeasuredLayout } = verifiedReferenceMatcher(reference);
  let previousTime = -Infinity;
  const matched = frames.map((frame, index) => {
    const geometry = geometryFrames[index];
    assert.ok(Number.isFinite(geometry?.timeMs) && geometry.timeMs > previousTime,
      "startup measured geometry timestamps are not strictly ordered");
    previousTime = geometry.timeMs;
    const card = geometry.cardRectPt;
    assert.ok(card && ["left", "top", "right", "bottom"].every(edge => Number.isFinite(card[edge])) &&
      card.right > card.left && card.bottom > card.top, "startup measured card rectangle is missing or invalid");
    const capture = frame?.capture;
    assert.ok(capture?.screenRect && capture.contentRect, "startup normal callback geometry is missing");
    const rect = { x: capture.screenRect.x + card.left + nativeInsetsPt.left,
      y: capture.screenRect.y + card.top + nativeInsetsPt.top,
      width: card.right - card.left - nativeInsetsPt.left - nativeInsetsPt.right,
      height: card.bottom - card.top - nativeInsetsPt.top - nativeInsetsPt.bottom };
    return matchesMeasuredLayout(capture, rect, { ...rect });
  });
  const anchorFrameIndex = matched.findIndex((value, index) => geometryFrames[index].timeMs >= anchorPresentedAtMs && geometryFrames[index].timeMs <= targetRequestAtMs && !value);
  assert.ok(anchorFrameIndex >= 0, "normal capture contains no physically different anchor after its presentation boundary");
  const frameIndex = matched.findIndex((value, index) => index > anchorFrameIndex && value);
  assert.ok(frameIndex >= 0, "normal capture contains no new exact terminal reference pixels after its different anchor");
  const captured = frames[frameIndex].capture;
  const card = geometryFrames[frameIndex].cardRectPt;
  const matchedRectPt = { x: captured.screenRect.x + card.left + nativeInsetsPt.left,
    y: captured.screenRect.y + card.top + nativeInsetsPt.top,
    width: card.right - card.left - nativeInsetsPt.left - nativeInsetsPt.right,
    height: card.bottom - card.top - nativeInsetsPt.top - nativeInsetsPt.bottom };
  return { matchedRectPt, anchorFrameIndex, frameIndex, proof: "verified-terminal-reference-start-exact-pixels", referenceFrame: reference.source.frame,
    slotProjection: { anchorFrameIndex: anchorPhaseIndex, declaredInsetsPt: slotInsetsPt, nativeInsetsPt,
      anchorNativeRectPt: { ...native } } };
}
