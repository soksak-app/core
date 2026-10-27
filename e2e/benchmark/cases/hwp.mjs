import assert from "node:assert/strict";

import { drag } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { LAYOUT_DISPLAY_LIMIT_MS } from "@soksak/window-check/view-metrics.mjs";
import { firstContentFrame } from "../../view-first-content.mjs";
import { declaredSlotInsets, effectiveCardCornerRadiusPt, findFirstChangedSlotFrame, measureViewFrameGeometry,
  VIEW_GEOMETRY_COLOR_TOLERANCE } from "../../view-frame-geometry.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, mapViewContentFramesToCapture,
  monotonicTimeMs, requireViewContentFrameCoverage, rootNativePlacementBeforeCapture,
  selectOneShotViewSourceFrame,
  withViewContentTrace }
  from "../../view-metrics-collection.mjs";
import { viewContentCases } from "../../view-content.mjs";

const HWP_CONTENT = "속삭한글문서확인";
export const HWP_VIEW_BASELINES_MS = Object.freeze({ wailsv3: 701, tauriv2: 813 });
const GEOMETRY_LIMIT_PT = 2;
const NATIVE_MARKER_COLOR = [0, 255, 255];
const NATIVE_MARKER_WIDTH_PT = 2;
const HTML_PAINT_MARKER_COLOR = [255, 0, 255];

/** Requires the current view and studio document histories from the HWP diagnostic reply. */
export function hwpDocumentHistoryEvidence(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "HWP history evidence must be an object");
  for (const field of ["historyEntries", "regionHistoryEntries"]) {
    assert.ok(Number.isSafeInteger(value[field]) && value[field] > 0,
      `HWP diagnostic reply is missing a positive ${field} count`);
  }
  assert.equal(value.historyEntries, 1, "HWP root document history must contain exactly its initial entry");
  assert.equal(value.regionHistoryEntries, 1, "HWP studio document history must contain exactly its initial entry");
  return { historyEntries: value.historyEntries, regionHistoryEntries: value.regionHistoryEntries };
}

/** Compares screenshot-measured HWP studio bounds with the current declared document-region slot. */
export function assertHwpFrameMatchesSlot(geometry, slotInsetsPt) {
  assert.ok(geometry?.cardRectPt && geometry?.nativeRectPt,
    "HWP frame geometry requires measured card and studio rectangles");
  assert.ok(slotInsetsPt && [slotInsetsPt.left, slotInsetsPt.top, slotInsetsPt.right, slotInsetsPt.bottom]
    .every((value) => Number.isFinite(value) && value >= 0), "HWP frame geometry requires declared slot insets");
  const expected = {
    left: geometry.cardRectPt.left + slotInsetsPt.left,
    top: geometry.cardRectPt.top + slotInsetsPt.top,
    right: geometry.cardRectPt.right - slotInsetsPt.right,
    bottom: geometry.cardRectPt.bottom - slotInsetsPt.bottom,
  };
  assert.ok(expected.right > expected.left && expected.bottom > expected.top,
    `HWP declared studio slot has no positive area: ${JSON.stringify(expected)}`);
  const residualPt = Object.fromEntries(["left", "top", "right", "bottom"]
    .map((edge) => [edge, geometry.nativeRectPt[edge] - expected[edge]]));
  const errorPt = Math.max(...Object.values(residualPt).map(Math.abs));
  if (errorPt > GEOMETRY_LIMIT_PT) {
    throw new Error(`HWP native region bounds differ from the declared slot by ${errorPt} pt `
      + `(limit ${GEOMETRY_LIMIT_PT} pt); HWP frame geometry evidence ${JSON.stringify({
        frameIndex: geometry.frameIndex, timeMs: geometry.timeMs, actualEdgesPt: geometry.nativeRectPt,
        expectedEdgesPt: expected, residualPt, slotInsetsPt,
      })}`);
  }
  return errorPt;
}

/** Validates the declared native studio marker reply. */
export function validateHwpNativeMarkerReply(value, enabled = true) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value),
    "HWP native viewport marker reply must be an object");
  assert.equal(value.enabled, enabled, `HWP native viewport marker enabled state must be ${enabled}`);
  if (enabled) {
    assert.equal(value.kind, "native", "HWP viewport marker must identify the native view layer");
    assert.deepEqual(value.markerColor, NATIVE_MARKER_COLOR,
      "HWP native viewport marker color differs from its cyan RGB token");
    assert.equal(value.borderWidthPt, NATIVE_MARKER_WIDTH_PT,
      "HWP native viewport marker border must be exactly 2 points");
  }
  return value;
}

/** Starts the native studio marker around one capture action and removes it on every exit path. */
export async function withHwpNativeMarker(s, surface, action) {
  assert.ok(typeof surface === "string" && surface.length > 0, "HWP native marker requires a surface identity");
  assert.equal(typeof action, "function", "HWP native marker action is required");
  let marker;
  let result;
  let actionError;
  let stopError;
  let started = false;
  let markerActive = false;
  const stopMarker = async () => {
    if (!markerActive) return;
    validateHwpNativeMarkerReply(await s.request("diagnostics.document.viewport-marker",
      { surface, document: "studio", enabled: false }), false);
    markerActive = false;
  };
  try {
    marker = await s.request("diagnostics.document.viewport-marker", { surface, document: "studio", enabled: true });
    started = true;
    markerActive = true;
    assert.equal(typeof s.cleanup, "function", "HWP native marker requires session cleanup support");
    s.cleanup(async () => {
      if (markerActive) await stopMarker();
    });
    validateHwpNativeMarkerReply(marker);
    result = await action(marker);
  } catch (error) {
    actionError = error;
  }
  if (started) {
    try {
      await stopMarker();
    } catch (error) {
      stopError = error;
    }
  }
  if (actionError && stopError) {
    throw new AggregateError([actionError, stopError], `HWP native marker action and cleanup failed for ${surface}`);
  }
  if (actionError) throw actionError;
  if (stopError) throw stopError;
  return { marker, result };
}

/** Records reclaim for the complete HWP opening set; the reclaim collector owns closing those views. */
export async function collectHwpReclaimAfterMotion(t, s, descriptor, start, evidence,
  collect = collectViewReclaimMeasurements) {
  const surface = start.warmDisplay.surface;
  assert.ok(start.opened.some((view) => view.surface === surface),
    `HWP motion view ${surface} is missing from the opening set passed to reclaim`);
  assert.ok(typeof start.card === "string" && start.card.length > 0,
    "HWP reclaim requires its original measurement card");
  assert.ok(Number.isFinite(start.initialCardWidth) && start.initialCardWidth > 0,
    `HWP reclaim has invalid initial card width ${JSON.stringify(start.initialCardWidth)}`);
  const grid = await s.get("core.grid");
  const card = grid?.cards?.find((item) => item.id === start.card);
  assert.ok(Number.isFinite(card?.w) && card.w > 0,
    `HWP reclaim card ${start.card} has no current positive width`);
  if (card.w !== start.initialCardWidth) {
    await s.run("core.grid.size", { card: start.card, axis: "x", size: start.initialCardWidth });
    const { displayed } = await s.presented();
    assert.ok(Number.isFinite(displayed) && displayed >= 0,
      `HWP reclaim card width restoration has invalid presentation time ${JSON.stringify(displayed)}`);
  }
  return collect(t, s, descriptor, start.opened, evidence);
}

/** HWP inputs for the shared view startup, footprint, and reclaim collector. */
export async function hwpViewDescriptor(s, diagnostic = () => {}, captureObservationWindowMs) {
  const cases = await viewContentCases(s, diagnostic);
  const content = cases.get("hwp");
  assert.ok(content?.params?.path, "the HWP measurement fixture has no document path");
  const path = content.params.path;
  const read = async (session, surface) => hwpDocumentHistoryEvidence(
    await session.run("hwp.diagnostics.frames.read", {}, surface));
  return Object.freeze({
    plugin: "hwp",
    params: content.params,
    expectedContent: HWP_CONTENT,
    language: "ko-KR",
    ...(captureObservationWindowMs === undefined ? {} : { captureObservationWindowMs }),
    readinessStatus: "hwp.document",
    readiness: async (session, surface) => {
      await session.until("hwp.document", (value) => value.path === path && value.phase === "ready" && value.pages === 1,
        `HWP view ${surface} did not load its one-page measurement document`, { surface });
      const studio = await session.rect("hwp.studio", undefined, surface);
      assert.ok(studio.width > 0 && studio.height > 0, `HWP view ${surface} has no visible studio region`);
      return read(session, surface);
    },
    readDocument: read,
    startContentTrace: async (session, surface) => {
      return session.run("hwp.diagnostics.frames.start", {}, surface);
    },
    stopContentTrace: async (session, surface) => {
      const value = await session.run("hwp.diagnostics.frames.stop", {}, surface);
      assert.equal(value.enabled, false, `HWP view ${surface} content-frame observer did not stop`);
      assert.equal(value.studioViewport, null, `HWP view ${surface} HTML viewport marker remained after observer stop`);
      return value;
    },
  });
}

/** Reads the current HTML paint marker while the explicit observer start is still active. */
export async function readHwpPaintViewport(s, surface) {
  const result = await s.run("hwp.diagnostics.frames.read", {}, surface);
  assert.ok(result?.studioViewport, `HWP view ${surface} has no active HTML viewport paint marker`);
  return result.studioViewport;
}

/** Finds the earliest HWP view recording frame that contains its fixture document text. */
export async function hwpFirstContentFrame({ captured, rect, directory, recognizeFrame }) {
  return firstContentFrame({ captured, rect, expected: HWP_CONTENT, language: "ko-KR", directory, recognizeFrame });
}

function documentRow(host, surface, document) {
  const row = host.documents.find((item) => item.surface === surface && item.document === document);
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `HWP surface ${surface} has no visible ${document || "root"} document frame`);
  return row;
}

function captureFrames(result, label) {
  if (Object.hasOwn(result, "limited")) {
    assert.equal(result.limited, false, `HWP ${label} recording reached its bounded frame limit`);
  }
  const files = frames(result.frames);
  assert.equal(files.length, result.count, `HWP ${label} recording omitted finalized frame files`);
  assert.ok(files.length > 0, `HWP ${label} recording contains no frames`);
  return files.map(readFrame);
}

function hwpThemeGeometry(theme, cornerRadiusPt) {
  const parse = (name, token) => {
    assert.ok(typeof token === "string" && /^#[0-9a-f]{6}$/iu.test(token), `core theme ${name} is not an RGB hex token`);
    return [1, 3, 5].map((index) => Number.parseInt(token.slice(index, index + 2), 16));
  };
  const borderColors = [theme.edge, theme.rule, theme.focus].filter((value) => value !== undefined)
    .map((value, index) => parse(`border ${index}`, value));
  assert.ok(borderColors.length > 0, "core theme has no declared card border or focus color");
  return { cardColor: parse("card", theme.card), planeColor: parse("background", theme.bg),
    borderColors, cornerRadiusPt };
}

/** Measures the cyan border drawn by the native studio view, not HTML paint or natural document extent. */
export function measureHwpNativeMarkerFrame(frame, markerReply, { targetRect, themeGeometry } = {}) {
  const marker = validateHwpNativeMarkerReply(markerReply);
  assert.ok(targetRect && [targetRect.x, targetRect.y, targetRect.width, targetRect.height]
    .every(Number.isFinite) && targetRect.width > 0 && targetRect.height > 0,
  "HWP native marker measurement requires the target card rectangle");
  assert.ok(themeGeometry && typeof themeGeometry === "object", "HWP marker measurement requires the active card palette");
  const captureRatio = frame?.scale * frame?.contentScale;
  assert.ok(Number.isFinite(captureRatio) && captureRatio > 0,
    `HWP marker measurement has an invalid capture ratio ${captureRatio}`);
  const borderPixels = marker.borderWidthPt * captureRatio;
  assert.ok(Number.isSafeInteger(borderPixels),
    "HWP native marker border is not an integral capture-pixel width at this capture scale");
  const geometry = measureViewFrameGeometry(frame, { ...themeGeometry, contentColor: marker.markerColor,
    targetRect, colorTolerance: VIEW_GEOMETRY_COLOR_TOLERANCE });
  const card = geometry.cardRectPx;
  const bounds = geometry.nativeRectPx;
  const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  assert.ok(Number.isSafeInteger(width) && width > borderPixels * 2
    && Number.isSafeInteger(height) && height > borderPixels * 2,
  "HWP target card has no native marker with positive interior area");
  const isMarker = (x, y) => {
    const offset = y * frame.stride + x * 4;
    return frame.data[offset + 3] === 255
      && [2, 1, 0].every((channel, index) => Math.abs(frame.data[offset + channel] - marker.markerColor[index])
        <= VIEW_GEOMETRY_COLOR_TOLERANCE);
  };
  for (let y = card.top; y < card.bottom; y++) {
    for (let x = card.left; x < card.right; x++) {
      const inBounds = x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
      const expectedBorder = inBounds && (x < bounds.left + borderPixels || x >= bounds.right - borderPixels
        || y < bounds.top + borderPixels || y >= bounds.bottom - borderPixels);
      if (isMarker(x, y) && !expectedBorder) {
        throw new Error("HWP native marker has extra cyan pixels in the selected card");
      }
      if (expectedBorder && !isMarker(x, y)) {
        throw new Error("HWP native marker is missing part of its four-edge border");
      }
    }
  }
  return { ...geometry, geometryEvidence: "native region bounds alignment",
    nativeMarker: { color: [...marker.markerColor], borderWidthPt: marker.borderWidthPt, captureRatio } };
}

function measureHwpCaptureFrame(frame, frameIndex, markerReply, { targetRect, themeGeometry, slotInsetsPt }) {
  let geometry;
  try {
    geometry = measureHwpNativeMarkerFrame(frame, markerReply, { targetRect, themeGeometry });
  } catch (error) {
    throw new Error(`HWP native region pixel measurement failed; HWP frame geometry evidence ${JSON.stringify({
      frameIndex, timeMs: frame.time, slotInsetsPt, markerColor: markerReply?.markerColor,
      measurementError: error.message,
    })}`, { cause: error });
  }
  geometry.frameIndex = frameIndex;
  geometry.timeMs = frame.time;
  geometry.errorPt = assertHwpFrameMatchesSlot(geometry, slotInsetsPt);
  return geometry;
}

/** Measures the magenta HTML viewport border separately from the native cyan region-bound marker. */
export function measureHwpPaintFrame(frame, frameIndex, viewport, { targetRect, themeGeometry, studioFrame } = {}) {
  assert.ok(Number.isSafeInteger(frameIndex) && frameIndex >= 0, "HWP paint frame index is invalid");
  assert.ok(viewport && typeof viewport === "object" && !Array.isArray(viewport),
    "HWP paint measurement requires the current studio viewport marker evidence");
  assert.deepEqual(viewport.markerColor, HTML_PAINT_MARKER_COLOR,
    "HWP HTML viewport paint marker color differs from its magenta RGB token");
  assert.equal(viewport.borderWidth, 2, "HWP HTML viewport paint marker border must be exactly 2 CSS px");
  assert.ok(Number.isFinite(viewport.innerWidth) && viewport.innerWidth > 8
    && Number.isFinite(viewport.innerHeight) && viewport.innerHeight > 8
    && viewport.rect && [viewport.rect.left, viewport.rect.top, viewport.rect.right, viewport.rect.bottom]
      .every(Number.isFinite), "HWP paint measurement requires finite current viewport dimensions and marker edges");
  assert.deepEqual(viewport.rect, { left: 4, top: 4,
    right: viewport.innerWidth - 4, bottom: viewport.innerHeight - 4 },
  "HWP HTML viewport marker must remain inset by 4 CSS px on every edge");
  assert.ok(studioFrame && Number.isFinite(studioFrame.width) && studioFrame.width > 0
    && Number.isFinite(studioFrame.height) && studioFrame.height > 0,
  "HWP paint measurement requires the current native studio frame");
  const geometry = measureViewFrameGeometry(frame, { ...themeGeometry, contentColor: HTML_PAINT_MARKER_COLOR,
    targetRect, colorTolerance: VIEW_GEOMETRY_COLOR_TOLERANCE });
  const scaleX = studioFrame.width / viewport.innerWidth;
  const scaleY = studioFrame.height / viewport.innerHeight;
  return {
    frameIndex,
    timeMs: frame.time,
    cardRectPt: geometry.cardRectPt,
    contentRectPt: geometry.nativeRectPt,
    contentInsetsPt: {
      left: viewport.rect.left * scaleX,
      top: viewport.rect.top * scaleY,
      right: (viewport.innerWidth - viewport.rect.right) * scaleX,
      bottom: (viewport.innerHeight - viewport.rect.bottom) * scaleY,
    },
    paintMarker: { color: [...viewport.markerColor], borderWidthCss: viewport.borderWidth,
      rect: { ...viewport.rect }, innerWidth: viewport.innerWidth, innerHeight: viewport.innerHeight },
  };
}

function cardTargetRect(grid, cardId) {
  const card = grid?.cards?.find((item) => item.id === cardId);
  const plane = grid?.plane;
  assert.ok(card && plane && [card.x, card.y, card.w, card.h, plane.x, plane.y].every(Number.isFinite)
    && card.w > 0 && card.h > 0, `HWP measurement card ${cardId} has no finite captured-card target`);
  return { x: plane.x + card.x, y: plane.y + card.y, width: card.w, height: card.h };
}

export async function layoutObservation(t, s, descriptor, surface, card, theme, cornerRadiusPt, { recognizeFrame } = {}) {
  const traced = await withViewContentTrace(t, s, descriptor, surface, async (startReply) => {
    assert.equal(startReply?.enabled, true, `HWP view ${surface} content-frame observer did not start`);
    return withHwpNativeMarker(s, surface, async (marker) => {
      const recording = await s.record();
      const grid = await s.get("core.grid");
      const pane = grid.cards.find((item) => item.id === card);
      assert.ok(pane && Number.isFinite(pane.w), `HWP measurement card ${card} has no current width`);
      const hostBefore = await s.get("host.window");
      const studioBefore = documentRow(hostBefore, surface, "studio");
      const baselineClock = await monotonicTimeMs(s);
      const beforeChangeTimeMs = baselineClock.timeMs;
      await s.run("core.grid.size", { card, axis: "x", size: pane.w + 80 });
      const { displayed } = await s.presented();
      const result = await recording.stop({ after: displayed + LAYOUT_DISPLAY_LIMIT_MS });
      return { displayed, beforeChangeTimeMs, result, captured: captureFrames(result, "layout"),
        nativeDocumentBefore: studioBefore.frame, marker };
    });
  });
  const { marker, result: action } = traced.action;
  const { beforeChangeTimeMs, displayed, captured, result, nativeDocumentBefore } = action;
  const host = await s.get("host.window");
  const studio = documentRow(host, surface, "studio");
  const nativePlacement = rootNativePlacementBeforeCapture(traced.events, surface, displayed,
    { afterMs: beforeChangeTimeMs });
  const sourceSelection = selectOneShotViewSourceFrame(traced.contentFrames,
    { requestAtMs: beforeChangeTimeMs, nativePlacement });
  const source = sourceSelection.frame;
  assert.ok(source, `HWP root trace has no source frame matching its final post-request native placement projection: ${JSON.stringify(sourceSelection.failure)}`);
  const previousSource = traced.contentFrames.filter((frame) => frame.sequence < source.sequence).at(-1);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const region = await s.rect("hwp.studio", undefined, surface);
  const slotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface,
    regionRect: { x: region.x, y: region.y, w: region.width, h: region.height } });
  const targetRect = cardTargetRect(grid, card);
  const themeGeometry = hwpThemeGeometry(theme, cornerRadiusPt);
  const measured = captured.map((frame, frameIndex) => {
    try {
      const geometry = measureHwpNativeMarkerFrame(frame, marker, { targetRect, themeGeometry });
      geometry.frameIndex = frameIndex;
      geometry.timeMs = frame.time;
      return geometry;
    } catch (error) {
      throw new Error(`HWP native region pixel measurement failed; HWP frame geometry evidence ${JSON.stringify({
        frameIndex, timeMs: frame.time, slotInsetsPt, markerColor: marker.markerColor,
        measurementError: error.message,
      })}`, { cause: error });
    }
  });
  let transition;
  try {
    transition = findFirstChangedSlotFrame(measured, { beforeChangeTimeMs, slotInsetsPt });
  } catch (error) {
    const placed = surfaces.find((item) => item.surface === surface);
    assert.ok(placed?.declared && placed?.applied,
      `HWP surface ${surface} has no declared and applied slot for pixel comparison`);
    const declaredSlotRectPt = {
      left: placed.declared.x + region.x - placed.applied.x,
      top: placed.declared.y + region.y - placed.applied.y,
      right: placed.declared.x + region.x - placed.applied.x + region.width,
      bottom: placed.declared.y + region.y - placed.applied.y + region.height,
    };
    const rows = measured.map((geometry, frameIndex) => {
      const actual = geometry.nativeRectPt;
      const expectedEdgesPt = {
        left: geometry.cardRectPt.left + slotInsetsPt.left,
        top: geometry.cardRectPt.top + slotInsetsPt.top,
        right: geometry.cardRectPt.right - slotInsetsPt.right,
        bottom: geometry.cardRectPt.bottom - slotInsetsPt.bottom,
      };
      const residualPt = Object.fromEntries(["left", "top", "right", "bottom"].map((edge) => [
        edge, actual[edge] - expectedEdgesPt[edge],
      ]));
      return { frameIndex, timeMs: captured[frameIndex].time, actualEdgesPt: actual, expectedEdgesPt,
        residualPt, slotInsetsPt };
    });
    const afterSource = rows.filter((row) => row.timeMs >= source.timeRange.upperMs);
    const closest = afterSource.sort((left, right) => Math.max(...Object.values(left.residualPt).map(Math.abs))
      - Math.max(...Object.values(right.residualPt).map(Math.abs)))[0];
    throw new Error(`${error.message}; HWP pixel geometry evidence ${JSON.stringify({
      tolerancePt: 2,
      previousSourceFrame: previousSource && { frameTimeMs: previousSource.frameTimeMs,
        timeRange: previousSource.timeRange,
        width: previousSource.width, height: previousSource.height },
      sourceFrame: { frameTimeMs: source.frameTimeMs, timeRange: source.timeRange,
        width: source.width, height: source.height },
      rootNativeFrame: nativePlacement.framePt,
      nativeDocumentBefore,
      nativeDocumentAfter: studio.frame,
      declaredSurface: placed.declared,
      appliedSurface: placed.applied,
      DOMRegion: { x: region.x, y: region.y, width: region.width, height: region.height },
      declaredSlotRectPt,
      closestPostSourceFrame: closest,
      frameResiduals: rows,
    })}`, { cause: error });
  }
  const changeFrame = captured[transition.changeFrameIndex];
  const contentDeadlineMs = changeFrame.time + LAYOUT_DISPLAY_LIMIT_MS;
  const lastFrame = captured.at(-1);
  assert.ok(lastFrame.time >= contentDeadlineMs,
    `HWP layout recording ended at ${lastFrame.time} ms before the ${LAYOUT_DISPLAY_LIMIT_MS} ms content deadline `
      + `at ${contentDeadlineMs} ms after its first changed frame`);
  const captureAfter = Math.max(displayed, source.timeRange.upperMs);
  const candidates = transition.slotMatchFrameIndices.filter((index) => captured[index].time >= captureAfter);
  assert.ok(candidates.length > 0, `HWP layout has no declared-slot pixel match at or after ${captureAfter} ms`);
  const localProof = await hwpFirstContentFrame({ captured: candidates.map((index) => captured[index]),
    rect: { x: studio.frame.x, y: studio.frame.y, w: studio.frame.width, h: studio.frame.height },
    directory: result.frames, recognizeFrame });
  const frameIndex = candidates[localProof.frameIndex];
  const proof = localProof.proof;
  const geometry = measured[frameIndex];
  const initialGeometryErrorPt = assertHwpFrameMatchesSlot(geometry, slotInsetsPt);
  return {
    changeFrame: { frameIndex: transition.changeFrameIndex, frameCount: captured.length,
      timeMs: captured[transition.changeFrameIndex].time },
    contentFrame: { frameIndex, frameCount: captured.length, timeMs: captured[frameIndex].time,
      requestAtMs: beforeChangeTimeMs, displayedAtMs: displayed, sourceTimeRange: source.timeRange,
      width: source.width, height: source.height, nativePlacement,
      surfaceEvents: traced.events.filter((event) => event?.event === "host.trace.surface" && event.fields?.surface === surface),
      proof },
    sourceFrame: source,
    slotInsetsPt,
    initialGeometry: { frameIndex, timeMs: captured[frameIndex].time, cardRectPt: geometry.cardRectPt,
      nativeRectPt: geometry.nativeRectPt, slotInsetsPt, errorPt: initialGeometryErrorPt,
      geometryEvidence: geometry.geometryEvidence, nativeMarker: geometry.nativeMarker },
    htmlViewportEvidence: traced.start?.studioViewport,
    markerGeometry: { color: [...marker.markerColor], borderWidthPt: marker.borderWidthPt,
      geometryEvidence: "native region bounds alignment" },
    events: traced.events,
    captureDirectory: result.frames,
  };
}

async function dragObservation(t, s, descriptor, surface, card, theme, cornerRadiusPt) {
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const rootSlotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface });
  const region = await s.rect("hwp.studio", undefined, surface);
  const slotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface,
    regionRect: { x: region.x, y: region.y, w: region.width, h: region.height } });
  await s.presented();
  const traced = await withViewContentTrace(t, s, descriptor, surface, async (startReply) => {
    assert.equal(startReply?.enabled, true, `HWP view ${surface} content-frame observer did not start`);
    return withHwpNativeMarker(s, surface, async () => {
      const run = await drag(t, s, { axis: "x", line: 1, dx: 80, dy: 0, ms: 500, times: 1 }, { capture: true });
      const studioViewport = await readHwpPaintViewport(s, surface);
      return { run, studioViewport };
    });
  });
  const { marker, result: action } = traced.action;
  const run = action.run;
  const paintViewport = action.studioViewport;
  const captured = captureFrames(run, "drag");
  assert.ok(captured.length > 2, "HWP drag recording contains too few frames");
  const firstGestureFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks[0]);
  const gestureEndedFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks.at(-1));
  assert.ok(firstGestureFrameIndex >= 0 && gestureEndedFrameIndex >= firstGestureFrameIndex,
    "HWP drag capture does not cover the complete requested gesture");
  const host = await s.get("host.window");
  const root = documentRow(host, surface, "");
  const studio = documentRow(host, surface, "studio");
  const gridAfter = await s.get("core.grid");
  const targetRect = cardTargetRect(gridAfter, card);
  const themeGeometry = hwpThemeGeometry(theme, cornerRadiusPt);
  const geometryFrames = [];
  for (let frameIndex = firstGestureFrameIndex; frameIndex <= gestureEndedFrameIndex; frameIndex++) {
    const measured = measureHwpCaptureFrame(captured[frameIndex], frameIndex, marker,
      { targetRect, themeGeometry, slotInsetsPt });
    geometryFrames.push({ frameIndex, timeMs: captured[frameIndex].time,
      cardRectPt: measured.cardRectPt, nativeRectPt: measured.nativeRectPt, slotInsetsPt,
      errorPt: measured.errorPt, geometryEvidence: measured.geometryEvidence, nativeMarker: measured.nativeMarker });
  }
  const tailGeometryFrames = [];
  for (let frameIndex = gestureEndedFrameIndex + 1; frameIndex < captured.length; frameIndex++) {
    const nativeMeasured = measureHwpCaptureFrame(captured[frameIndex], frameIndex, marker,
      { targetRect, themeGeometry, slotInsetsPt });
    const paintMeasured = measureHwpPaintFrame(captured[frameIndex], frameIndex, paintViewport,
      { targetRect, themeGeometry, studioFrame: studio.frame });
    assert.deepEqual(paintMeasured.cardRectPt, nativeMeasured.cardRectPt,
      `HWP paint and native marker selected different card geometry in capture frame ${frameIndex}`);
    tailGeometryFrames.push({ frameIndex, timeMs: captured[frameIndex].time,
      cardRectPt: nativeMeasured.cardRectPt, nativeRectPt: nativeMeasured.nativeRectPt,
      contentRectPt: paintMeasured.contentRectPt, slotInsetsPt, contentInsetsPt: paintMeasured.contentInsetsPt,
      nativeMarker: nativeMeasured.nativeMarker, paintMarker: paintMeasured.paintMarker });
  }
  const mapped = requireViewContentFrameCoverage(mapViewContentFramesToCapture(traced.contentFrames, captured), {
    gestureStartedAtMs: run.ticks[0], gestureEndedAtMs: run.ticks.at(-1),
  });
  const contentFrames = mapped.map((source) => {
    const displayCaptureIndex = captured.findIndex((frame) => frame.time >= Math.max(run.displayed, source.timeRange.upperMs));
    return { sourceSequence: source.sourceSequence, frameIndex: source.frameIndex,
      captureTimeMs: source.frameIndex === null ? null : captured[source.frameIndex].time,
      displayCapture: displayCaptureIndex < 0 ? null : { frameIndex: displayCaptureIndex,
        timeMs: captured[displayCaptureIndex].time },
      frameTimeMs: source.frameTimeMs, timeRange: source.timeRange, width: source.width, height: source.height, source };
  });
  return {
    recordedFrameCount: captured.length,
    firstGestureFrameIndex,
    lastGestureFrameIndex: gestureEndedFrameIndex,
    gestureEndedFrameIndex,
    gestureStartedAtMs: run.ticks[0],
    gestureEndedAtMs: run.ticks.at(-1),
    finalPresentation: { displayedAtMs: run.displayed,
      targetViewport: { width: Math.trunc(root.frame.width), height: Math.trunc(root.frame.height) },
      targetRectPt: { left: studio.frame.x, top: studio.frame.y,
        right: studio.frame.x + studio.frame.width, bottom: studio.frame.y + studio.frame.height } },
    geometryFrames,
    tailGeometryFrames,
    contentFrames,
    sourceContentFrames: traced.contentFrames,
    htmlViewportEvidence: traced.start?.studioViewport,
    paintViewportEvidence: paintViewport,
    markerGeometry: { color: [...marker.markerColor], borderWidthPt: marker.borderWidthPt,
      geometryEvidence: "native region bounds alignment" },
    rootSlotInsetsPt,
    layouts: run.layouts,
    ticks: run.ticks,
    events: traced.events,
    captureDirectory: run.frames,
  };
}

/** Collects the HWP lifecycle, source content, layout and full-gesture measurements. */
export async function collectHwpViewMeasurements(t, s, { baselineMs } = {}) {
  if (!Number.isFinite(baselineMs) || baselineMs <= 0) {
    throw new Error(`HWP first-display baseline must be finite and positive, found ${JSON.stringify(baselineMs)}`);
  }
  const descriptor = await hwpViewDescriptor(s, (message) => t.diagnostic(message), baselineMs + 300);
  const start = await collectViewStartAndMemory(t, s, descriptor, { viewCount: 3 });
  const openingGrid = await s.get("core.grid");
  const openingCard = openingGrid?.cards?.find((item) => item.id === start.card);
  assert.ok(Number.isFinite(openingCard?.w) && openingCard.w > 0,
    `HWP measurement card ${start.card} has no initial positive width`);
  start.initialCardWidth = openingCard.w;
  const surface = start.warmDisplay.surface;
  const settings = (await s.get("core.settings")).values;
  const cornerRadiusPt = effectiveCardCornerRadiusPt(settings);
  const theme = (await s.get("core.themes")).find((item) => item.name === settings.theme)?.[settings.mode];
  assert.ok(theme, `active core theme ${settings.theme}/${settings.mode} is unavailable`);
  const layout = await layoutObservation(t, s, descriptor, surface, start.card, theme, cornerRadiusPt);
  const drag = await dragObservation(t, s, descriptor, surface, start.card, theme, cornerRadiusPt);
  const evidence = { events: [...start.events, ...layout.events, ...drag.events],
    recordings: [...start.recordings, { directory: layout.captureDirectory }, { directory: drag.captureDirectory }] };
  const reclaim = await collectHwpReclaimAfterMotion(t, s, descriptor, start, evidence);
  return {
    plugin: descriptor.plugin,
    host: s.app.name,
    total: start.total,
    reclaim,
    warmDisplay: start.warmDisplay,
    newProcess: { processStarts: start.processStarts, firstDisplays: start.firstDisplays },
    layoutDisplay: [layout],
    drag,
    _evidence: { ...evidence, initialGeometry: layout.initialGeometry, markerGeometry: layout.markerGeometry },
  };
}
