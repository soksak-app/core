import assert from "node:assert/strict";

import { drag } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { firstContentFrame } from "../../view-first-content.mjs";
import { declaredSlotInsets, effectiveCardCornerRadiusPt, findFirstChangedSlotFrame, measureViewFrameGeometry,
  VIEW_GEOMETRY_COLOR_TOLERANCE } from "../../view-frame-geometry.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, mapViewContentFramesToCapture,
  monotonicTimeMs, requireViewContentFrameCoverage, rootNativePlacementForSource, withViewContentTrace }
  from "../../view-metrics-collection.mjs";
import { viewContentCases } from "../../view-content.mjs";

const HWP_CONTENT = "속삭한글문서확인";
const GEOMETRY_LIMIT_PT = 2;

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
  const errorPt = Math.max(...["left", "top", "right", "bottom"]
    .map((edge) => Math.abs(expected[edge] - geometry.nativeRectPt[edge])));
  assert.ok(errorPt <= GEOMETRY_LIMIT_PT,
    `HWP studio frame differs from its declared slot by ${errorPt} pt (limit ${GEOMETRY_LIMIT_PT} pt)`);
  return errorPt;
}

/** HWP inputs for the shared view startup, footprint, and reclaim collector. */
export async function hwpViewDescriptor(s, diagnostic = () => {}) {
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
      assert.equal(value.studioViewport, null, `HWP view ${surface} diagnostic viewport marker remained after stop`);
      return value;
    },
  });
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

function hwpThemeGeometry(theme, contentColor, cornerRadiusPt) {
  const parse = (name, token) => {
    assert.ok(typeof token === "string" && /^#[0-9a-f]{6}$/iu.test(token), `core theme ${name} is not an RGB hex token`);
    return [1, 3, 5].map((index) => Number.parseInt(token.slice(index, index + 2), 16));
  };
  const borderColors = [theme.edge, theme.rule, theme.focus].filter((value) => value !== undefined)
    .map((value, index) => parse(`border ${index}`, value));
  assert.ok(borderColors.length > 0, "core theme has no declared card border or focus color");
  return { contentColor, cardColor: parse("card", theme.card), planeColor: parse("background", theme.bg),
    borderColors, cornerRadiusPt };
}

function validateHwpStudioViewport(value) {
  assert.ok(value && typeof value === "object", "HWP marker reply is missing studio viewport metadata");
  assert.deepEqual(value.markerColor, [255, 0, 255], "HWP marker color differs from its declared unique RGB token");
  assert.equal(value.borderWidth, 2, "HWP marker border must be exactly 2 CSS pixels");
  for (const field of ["innerWidth", "innerHeight", "clientWidth", "clientHeight"]) {
    assert.ok(Number.isFinite(value[field]) && value[field] > 0, `HWP marker reply has invalid ${field}`);
  }
  assert.deepEqual(value.rect, { left: 0, top: 0, right: value.innerWidth, bottom: value.innerHeight },
    "HWP marker does not cover the declared studio viewport");
  assert.equal(value.clientWidth, value.innerWidth, "HWP studio viewport has a horizontal scrollbar gutter");
  assert.equal(value.clientHeight, value.innerHeight, "HWP studio viewport has a vertical scrollbar gutter");
  assert.deepEqual(value.visualViewport, { width: value.innerWidth, height: value.innerHeight,
    offsetLeft: 0, offsetTop: 0, scale: 1 }, "HWP visual viewport is zoomed, offset, or smaller than its layout viewport");
  assert.deepEqual(value.fixedContainingBlock, { transform: "none", perspective: "none", filter: "none",
    contain: "none", willChange: "auto", containerType: "normal" },
  "HWP fixed marker has a transformed or contained ancestor");
  return value;
}

/** Measures one diagnostic HWP viewport border from captured pixels; it does not infer natural content bounds. */
export function measureHwpViewportMarkerFrame(frame, viewportReply, { targetRect, themeGeometry } = {}) {
  const viewport = validateHwpStudioViewport(viewportReply);
  assert.ok(targetRect && [targetRect.x, targetRect.y, targetRect.width, targetRect.height]
    .every(Number.isFinite) && targetRect.width > 0 && targetRect.height > 0,
  "HWP marker measurement requires the visible target card rectangle");
  assert.ok(themeGeometry && typeof themeGeometry === "object", "HWP marker measurement requires the active card palette");
  const captureRatio = frame?.scale * frame?.contentScale;
  assert.ok(Number.isFinite(captureRatio) && captureRatio > 0,
    `HWP marker measurement has an invalid capture ratio ${captureRatio}`);
  const borderPixels = viewport.borderWidth * captureRatio;
  assert.ok(Number.isSafeInteger(borderPixels), "HWP viewport marker border is not an integral capture-pixel width");

  const cardGeometry = measureViewFrameGeometry(frame,
    { ...themeGeometry, contentColor: viewport.markerColor, targetRect,
      colorTolerance: VIEW_GEOMETRY_COLOR_TOLERANCE });
  const card = cardGeometry.cardRectPx;
  const bounds = cardGeometry.nativeRectPx;
  const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  assert.ok(Number.isSafeInteger(width) && width > borderPixels * 2
    && Number.isSafeInteger(height) && height > borderPixels * 2,
  "HWP target card has no complete viewport marker with positive interior area");
  const isMarker = (x, y) => {
    const offset = y * frame.stride + x * 4;
    return frame.data[offset + 3] === 255
      && [2, 1, 0].every((channel, index) => Math.abs(frame.data[offset + channel] - viewport.markerColor[index])
        <= VIEW_GEOMETRY_COLOR_TOLERANCE);
  };
  for (let y = card.top; y < card.bottom; y++) for (let x = card.left; x < card.right; x++) {
    if (!isMarker(x, y)) continue;
    const inBounds = x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
    const onBorder = inBounds && (x < bounds.left + borderPixels || x >= bounds.right - borderPixels
      || y < bounds.top + borderPixels || y >= bounds.bottom - borderPixels);
    assert.ok(onBorder, "extra marker pixels in the selected card");
  }
  for (let y = bounds.top; y < bounds.bottom; y++) for (let x = bounds.left; x < bounds.right; x++) {
    const actual = isMarker(x, y);
    const expected = x < bounds.left + borderPixels || x >= bounds.right - borderPixels
      || y < bounds.top + borderPixels || y >= bounds.bottom - borderPixels;
    assert.equal(actual, expected, "HWP viewport marker does not contain a complete 2-pixel border on all four edges");
  }
  const nativeRectPx = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
  const originX = frame.content.x * frame.scale, originY = frame.content.y * frame.scale;
  const nativeRectPt = {
    left: (bounds.left - originX) / captureRatio,
    top: (bounds.top - originY) / captureRatio,
    right: (bounds.right - originX) / captureRatio,
    bottom: (bounds.bottom - originY) / captureRatio,
  };
  return { ...cardGeometry, nativeRectPx, nativeRectPt,
    geometryEvidence: "marker-assisted viewport geometry",
    viewportMarker: { color: [...viewport.markerColor], borderWidthCssPx: viewport.borderWidth, captureRatio } };
}

export async function layoutObservation(t, s, descriptor, surface, card, theme, cornerRadiusPt) {
  const traced = await withViewContentTrace(t, s, descriptor, surface, async (startReply) => {
    assert.equal(startReply?.enabled, true, `HWP view ${surface} content-frame observer did not start`);
    const viewport = validateHwpStudioViewport(startReply.studioViewport);
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
    const result = await recording.stop({ after: displayed });
    return { displayed, beforeChangeTimeMs, result, captured: captureFrames(result, "layout"),
      nativeDocumentBefore: studioBefore.frame, viewport };
  });
  const { beforeChangeTimeMs, displayed, captured, result, nativeDocumentBefore } = traced.action;
  const host = await s.get("host.window");
  const studio = documentRow(host, surface, "studio");
  const nativePlacement = rootNativePlacementForSource(traced.events, surface, displayed,
    { afterMs: beforeChangeTimeMs });
  const source = traced.contentFrames.find((frame) => frame.timeMs >= nativePlacement.timeMs
    && frame.width === nativePlacement.webKitViewport.width
    && frame.height === nativePlacement.webKitViewport.height);
  assert.ok(source, "HWP root trace has no source frame matching its final post-request native placement projection");
  const previousSource = traced.contentFrames.filter((frame) => frame.timeMs < source.timeMs).at(-1);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const region = await s.rect("hwp.studio", undefined, surface);
  const slotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface,
    regionRect: { x: region.x, y: region.y, w: region.width, h: region.height } });
  const targetRect = { x: studio.frame.x, y: studio.frame.y,
    width: studio.frame.width, height: studio.frame.height };
  const viewport = traced.action.viewport;
  const themeGeometry = hwpThemeGeometry(theme, viewport.markerColor, cornerRadiusPt);
  const measured = captured.map((frame) => measureHwpViewportMarkerFrame(frame, viewport,
    { targetRect, themeGeometry }));
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
      const residualPt = Object.fromEntries(["left", "top", "right", "bottom"].map((edge) => [
        edge, actual[edge] - declaredSlotRectPt[edge],
      ]));
      return { frameIndex, timeMs: captured[frameIndex].time, nativeRectPt: actual, residualPt };
    });
    const afterSource = rows.filter((row) => row.timeMs >= source.timeMs);
    const closest = afterSource.sort((left, right) => Math.max(...Object.values(left.residualPt).map(Math.abs))
      - Math.max(...Object.values(right.residualPt).map(Math.abs)))[0];
    throw new Error(`${error.message}; HWP pixel geometry evidence ${JSON.stringify({
      tolerancePt: 2,
      previousSourceFrame: previousSource && { timeMs: previousSource.timeMs,
        width: previousSource.width, height: previousSource.height },
      sourceFrame: { timeMs: source.timeMs, width: source.width, height: source.height },
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
  const candidates = transition.slotMatchFrameIndices.filter((index) => captured[index].time >= source.timeMs);
  assert.ok(candidates.length > 0, "HWP layout has no declared-slot pixel match after its source resize event");
  const localProof = await hwpFirstContentFrame({ captured: candidates.map((index) => captured[index]),
    rect: { x: studio.frame.x, y: studio.frame.y, w: studio.frame.width, h: studio.frame.height }, directory: result.frames });
  const frameIndex = candidates[localProof.frameIndex];
  const proof = localProof.proof;
  const geometry = measured[frameIndex];
  const initialGeometryErrorPt = assertHwpFrameMatchesSlot(geometry, slotInsetsPt);
  return {
    changeFrame: { frameIndex: transition.changeFrameIndex, frameCount: captured.length,
      timeMs: captured[transition.changeFrameIndex].time },
    contentFrame: { frameIndex, frameCount: captured.length, timeMs: captured[frameIndex].time,
      requestAtMs: beforeChangeTimeMs, sourceTimeMs: source.timeMs,
      width: source.width, height: source.height, nativePlacement, proof },
    sourceFrame: source,
    slotInsetsPt,
    initialGeometry: { frameIndex, timeMs: captured[frameIndex].time, cardRectPt: geometry.cardRectPt,
      nativeRectPt: geometry.nativeRectPt, slotInsetsPt, errorPt: initialGeometryErrorPt,
      geometryEvidence: geometry.geometryEvidence, viewportMarker: geometry.viewportMarker },
    markerGeometry: { color: [...viewport.markerColor], borderWidthCssPx: viewport.borderWidth,
      geometryEvidence: "marker-assisted viewport geometry" },
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
  const nativeRootBefore = documentRow(await s.get("host.window"), surface, "");
  const baselineClock = await monotonicTimeMs(s);
  const baselineTimeMs = baselineClock.timeMs;
  const baseline = { surface, timeMs: baselineTimeMs, monoNs: baselineClock.monoNs, visible: nativeRootBefore.visible,
    framePt: nativeRootBefore.frame };
  const traced = await withViewContentTrace(t, s, descriptor, surface, async (startReply) => {
    assert.equal(startReply?.enabled, true, `HWP view ${surface} content-frame observer did not start`);
    const viewport = validateHwpStudioViewport(startReply.studioViewport);
    return { viewport,
      run: await drag(t, s, { axis: "x", line: 1, dx: 80, dy: 0, ms: 500, times: 1 }, { capture: true }) };
  });
  const run = traced.action.run;
  const captured = captureFrames(run, "drag");
  assert.ok(captured.length > 2, "HWP drag recording contains too few frames");
  const firstGestureFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks[0]);
  const gestureEndedFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks.at(-1));
  assert.ok(firstGestureFrameIndex >= 0 && gestureEndedFrameIndex >= firstGestureFrameIndex,
    "HWP drag capture does not cover the complete requested gesture");
  const host = await s.get("host.window");
  const studio = documentRow(host, surface, "studio");
  const targetRect = { x: studio.frame.x, y: studio.frame.y,
    width: studio.frame.width, height: studio.frame.height };
  const viewport = traced.action.viewport;
  const themeGeometry = hwpThemeGeometry(theme, viewport.markerColor, cornerRadiusPt);
  const geometryFrames = [];
  for (let frameIndex = firstGestureFrameIndex; frameIndex <= gestureEndedFrameIndex; frameIndex++) {
    const measured = measureHwpViewportMarkerFrame(captured[frameIndex], viewport, { targetRect, themeGeometry });
    const slotErrorPt = assertHwpFrameMatchesSlot(measured, slotInsetsPt);
    geometryFrames.push({ frameIndex, timeMs: captured[frameIndex].time,
      cardRectPt: measured.cardRectPt, nativeRectPt: measured.nativeRectPt, slotInsetsPt,
      errorPt: slotErrorPt, geometryEvidence: measured.geometryEvidence, viewportMarker: measured.viewportMarker });
  }
  const contentFrames = [];
  const mapped = requireViewContentFrameCoverage(mapViewContentFramesToCapture(traced.contentFrames, captured), {
    gestureStartedAtMs: run.ticks[0], gestureEndedAtMs: run.ticks.at(-1),
  });
  for (const source of mapped) {
    if (source.frameIndex === null) continue;
    const nativePlacement = rootNativePlacementForSource(traced.events, surface, source.timeMs, { baseline });
    contentFrames.push({ sourceSequence: source.sourceSequence, frameIndex: source.frameIndex,
      timeMs: source.timeMs, width: source.width, height: source.height,
      nativePlacement, source });
  }
  return {
    recordedFrameCount: captured.length,
    firstGestureFrameIndex,
    lastGestureFrameIndex: gestureEndedFrameIndex,
    gestureEndedFrameIndex,
    gestureStartedAtMs: run.ticks[0],
    gestureEndedAtMs: run.ticks.at(-1),
    geometryFrames,
    contentFrames,
    sourceContentFrames: traced.contentFrames,
    rootSlotInsetsPt,
    layouts: run.layouts,
    ticks: run.ticks,
    events: traced.events,
    captureDirectory: run.frames,
  };
}

/** Collects the HWP lifecycle, source content, layout and full-gesture measurements. */
export async function collectHwpViewMeasurements(t, s) {
  const descriptor = await hwpViewDescriptor(s, (message) => t.diagnostic(message));
  const start = await collectViewStartAndMemory(t, s, descriptor, { viewCount: 3 });
  const surface = start.warmDisplay.surface;
  const settings = (await s.get("core.settings")).values;
  const cornerRadiusPt = effectiveCardCornerRadiusPt(settings);
  const theme = (await s.get("core.themes")).find((item) => item.name === settings.theme)?.[settings.mode];
  assert.ok(theme, `active core theme ${settings.theme}/${settings.mode} is unavailable`);
  const layout = await layoutObservation(t, s, descriptor, surface, start.card, theme, cornerRadiusPt);
  const drag = await dragObservation(t, s, descriptor, surface, start.card, theme, cornerRadiusPt);
  const closeWarm = await s.run("core.tab.close", { tab: surface });
  assert.equal(closeWarm?.closed, true, `HWP motion view ${surface} did not close after capture`);
  await s.until("core.surfaces", (items) => !items.some((item) => item.surface === surface),
    `HWP motion view ${surface} remained registered after capture`);
  const evidence = { events: [...start.events, ...layout.events, ...drag.events],
    recordings: [...start.recordings, { directory: layout.captureDirectory }, { directory: drag.captureDirectory }] };
  const reclaim = await collectViewReclaimMeasurements(t, s, descriptor, start.opened, evidence);
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
