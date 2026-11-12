// The layout (v) and drag (viii) observations of a view that paints its document root with the `markerColor` of its
// content-trace start, as the section views of the core benchmarks do. The pixels of each capture are measured with the palette of
// the active core theme and that marker color. `owner` names the measured view in every error.
import assert from "node:assert/strict";

import { drag } from "./app.mjs";
import { frames, readFrame } from "./frame.mjs";
import { valueProof } from "./view-content.mjs";
import { declaredSlotInsets, findFirstChangedSlotFrame, measureViewFrameGeometry } from "./view-frame-geometry.mjs";
import { mapViewContentFramesToCapture, monotonicTimeMs, requireViewContentFrameCoverage, rootNativePlacementBeforeCapture,
  selectOneShotViewSourceFrame, withDragTraceMode, withViewContentTrace } from "./view-metrics-collection.mjs";

/** The size field of a core.grid card and its name, by the axis of core.grid.size. */
const AXIS = Object.freeze({ x: Object.freeze({ size: "w", name: "width" }), y: Object.freeze({ size: "h", name: "height" }) });

/** The colors of the active core theme ({card, bg, edge, rule, focus}) in the mode of the core settings. */
export async function activeCoreTheme(s) {
  const { values } = await s.get("core.settings");
  const mode = values.mode;
  const themeName = values.theme;
  const theme = (await s.get("core.themes")).find((item) => item.name === themeName)?.[mode];
  assert.ok(theme, `active core theme ${themeName}/${mode} is unavailable`);
  return theme;
}

/** Returns `markerColor` when it is three integers from 0 through 255; otherwise it fails with `owner`. */
export function requireMarkerColor(markerColor, owner) {
  assert.ok(Array.isArray(markerColor) && markerColor.length === 3
    && markerColor.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255),
  `${owner} trace start must declare a three-channel RGB paint marker color`);
  return markerColor;
}

/** Validates and applies the RGB paint color declared by the successful trace start of `owner`. */
export function paletteWithMarkerColor(palette, markerColor, owner) {
  requireMarkerColor(markerColor, owner);
  const geometryColors = [palette?.cardColor, palette?.planeColor, ...(palette?.borderColors ?? [])];
  const conflicts = geometryColors.some((color) => Array.isArray(color) && color.length === 3
    && color.every((channel, index) => Math.abs(channel - markerColor[index]) <= 4));
  assert.equal(conflicts, false,
    `${owner} diagnostic paint color ${JSON.stringify(markerColor)} conflicts with core card geometry colors`);
  return { ...palette, contentColor: [...markerColor] };
}

/** Uses the exact opaque CSS paint color set by the content-frame diagnostic of `owner` and the colors of the active theme. */
export function themeGeometryPalette(frame, rect, theme, cornerRadiusPt, markerColor, owner) {
  assert.ok(frame && frame.data instanceof Uint8Array && frame.data.length === frame.stride * frame.height,
    `${owner} palette requires a complete decoded frame`);
  assert.ok(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0, `${owner} palette requires a visible document rectangle`);
  assert.ok(theme && typeof theme === "object", `${owner} palette requires the active core theme`);
  assert.ok(Number.isFinite(cornerRadiusPt) && cornerRadiusPt >= 0,
    `${owner} palette requires the effective core card radius`);
  const parse = (name, token) => {
    assert.ok(typeof token === "string" && /^#[0-9a-f]{6}$/iu.test(token), `theme ${name} is not an RGB hex token`);
    return [1, 3, 5].map((index) => Number.parseInt(token.slice(index, index + 2), 16));
  };
  const cardColor = parse("card", theme.card);
  const planeColor = parse("background", theme.bg);
  const borderColors = [theme.edge, theme.rule, theme.focus].filter((value) => value !== undefined).map((value, index) =>
    parse(`border ${index}`, value));
  assert.ok(borderColors.length > 0, "theme has no declared border or focus color");
  return paletteWithMarkerColor({ cardColor, planeColor, borderColors, cornerRadiusPt }, markerColor, owner);
}

/** Records same-frame measured content geometry of `owner` for one post-gesture capture. */
export function dragTailGeometryFrame(frameIndex, measured, slotInsetsPt, owner) {
  assert.ok(Number.isSafeInteger(frameIndex) && frameIndex >= 0, `${owner} drag tail frame index is invalid`);
  assert.ok(Number.isFinite(measured?.timeMs) && measured.timeMs >= 0,
    `${owner} drag tail frame time is invalid`);
  assert.ok(measured?.cardRectPt && measured?.nativeRectPt,
    `${owner} drag tail requires measured card and content rectangles`);
  return { frameIndex, timeMs: measured.timeMs, cardRectPt: measured.cardRectPt,
    nativeRectPt: measured.nativeRectPt, contentRectPt: measured.nativeRectPt, slotInsetsPt,
    contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 } };
}

/** Preserves source dimensions of `owner` and the capture frame that proves its display. */
export function sourceContentFrame(source, captureTimeMs, displayCapture, owner) {
  assert.ok(Number.isSafeInteger(source?.sourceSequence) && source.sourceSequence >= 0,
    `${owner} source frame has an invalid sequence`);
  assert.ok(Number.isFinite(source?.frameTimeMs) && source.frameTimeMs >= 0
    && Number.isFinite(source?.timeRange?.lowerMs) && Number.isFinite(source?.timeRange?.upperMs)
    && source.timeRange.lowerMs <= source.timeRange.upperMs, `${owner} source frame has invalid timing evidence`);
  assert.ok(Number.isFinite(source?.width) && source.width > 0
    && Number.isFinite(source?.height) && source.height > 0, `${owner} source frame has invalid dimensions`);
  if (source.frameIndex === null) {
    assert.equal(captureTimeMs, null, `uncaptured ${owner} source frame must not have a capture timestamp`);
  } else {
    assert.ok(Number.isSafeInteger(source.frameIndex) && source.frameIndex >= 0,
      `${owner} source frame has an invalid capture index`);
    assert.ok(Number.isFinite(captureTimeMs) && captureTimeMs >= source.timeRange.upperMs,
      `${owner} source frame capture must be at or after its source interval`);
  }
  return { sourceSequence: source.sourceSequence, frameIndex: source.frameIndex, frameTimeMs: source.frameTimeMs,
    captureTimeMs, displayCapture, timeRange: source.timeRange, width: source.width, height: source.height, source };
}

function viewDocumentRow(host, surface, owner) {
  const row = host.documents.find((item) => item.surface === surface && item.document === "");
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `${owner} surface ${surface} has no visible view document frame`);
  return row;
}

/**
 * The layout observation (v) of the view `surface` of the card `card`: core.grid.size makes the card 80 larger on `axis`
 * (x or y) while the content trace of `descriptor` runs. The content frame is the first still whose pixels match the declared
 * slot requested at or after the source frame of the new size, and the content value that `descriptor.readContent` reads holds
 * `descriptor.expectedContent`. Each time of a frame is the request time of its still; the content frame is a final state,
 * judged whatever stills the recording lost, and the lost stills are reported with it (missed, late).
 */
export async function markerLayoutObservation(t, s, descriptor, surface, card, { owner, theme, cornerRadiusPt, axis }) {
  const dimension = AXIS[axis];
  assert.ok(dimension, `${owner} layout axis must be x or y, not ${JSON.stringify(axis)}`);
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () => {
    const recording = await s.record();
    const grid = await s.get("core.grid");
    const pane = grid.cards.find((item) => item.id === card);
    assert.ok(pane && Number.isFinite(pane[dimension.size]), `${owner} measurement card ${card} has no current ${dimension.name}`);
    const beforeRoot = viewDocumentRow(await s.get("host.window"), surface, owner);
    const beforeChangeTimeMs = (await monotonicTimeMs(s)).timeMs;
    await s.run("core.grid.size", { card, axis, size: pane[dimension.size] + 80 });
    const { displayed } = await s.presented();
    const result = await recording.stop({ after: displayed });
    const files = frames(result.frames);
    assert.equal(files.length, result.count, `${owner} layout recording omitted finalized frame files`);
    assert.ok(files.length > 0, `${owner} layout recording contains no frames`);
    return { displayed, beforeChangeTimeMs, result, captured: files.map(readFrame), paletteRect: beforeRoot.frame };
  });
  const { beforeChangeTimeMs, displayed, result, captured, paletteRect } = traced.action;
  const host = await s.get("host.window");
  const root = viewDocumentRow(host, surface, owner);
  const palette = themeGeometryPalette(captured[0], paletteRect, theme, cornerRadiusPt, traced.start?.markerColor, owner);
  const nativePlacement = rootNativePlacementBeforeCapture(traced.events, surface, displayed,
    { afterMs: beforeChangeTimeMs });
  const sourceSelection = selectOneShotViewSourceFrame(traced.contentFrames,
    { requestAtMs: beforeChangeTimeMs, nativePlacement });
  const source = sourceSelection.frame;
  assert.ok(source, `${owner} source has no frame matching its final post-request native placement projection: ${JSON.stringify(sourceSelection.failure)}`);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const targetRect = { x: root.frame.x, y: root.frame.y,
    width: root.frame.width, height: root.frame.height };
  const slotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface });
  const measured = captured.map((frame) => measureViewFrameGeometry(frame, { ...palette, targetRect }));
  const transition = findFirstChangedSlotFrame(measured, { beforeChangeTimeMs, slotInsetsPt });
  const captureAfter = Math.max(displayed, source.timeRange.upperMs);
  const candidates = transition.slotMatchFrameIndices.filter((index) => captured[index].requested >= captureAfter);
  assert.ok(candidates.length > 0, `${owner} layout has no declared-slot pixel match at or after ${captureAfter} ms`);
  const frameIndex = candidates[0];
  const proof = valueProof(descriptor.expectedContent, await descriptor.readContent(s, surface), owner);
  const geometry = measured[frameIndex];
  return {
    changeFrame: { frameIndex: transition.changeFrameIndex, frameCount: captured.length,
      timeMs: captured[transition.changeFrameIndex].requested },
    contentFrame: { frameIndex, frameCount: captured.length, timeMs: captured[frameIndex].requested,
      requestAtMs: beforeChangeTimeMs, displayedAtMs: displayed, sourceTimeRange: source.timeRange,
      width: source.width, height: source.height, nativePlacement,
      surfaceEvents: traced.events.filter((event) => event?.event === "host.trace.surface" && event.fields?.surface === surface),
      proof },
    sourceFrame: source,
    slotInsetsPt,
    initialGeometry: { frameIndex, timeMs: captured[frameIndex].requested, cardRectPt: geometry.cardRectPt,
      nativeRectPt: geometry.nativeRectPt, slotInsetsPt },
    pixelPalette: palette,
    events: traced.events,
    captureDirectory: result.frames,
    missed: result.missed,
    late: result.late,
  };
}

/**
 * The drag observation (viii) of the view `surface` of the card `card`: the drag `plan` (diagnostics.drag) runs with capture
 * while the content trace of `descriptor` runs, and each still is measured with `palette` and the marker color of that trace
 * start. The time of each frame is the request time of its still.
 */
export async function markerDragObservation(t, s, descriptor, surface, card, palette, { owner, plan }) {
  await s.presented();
  const { result: traced, phaseMode } = await withDragTraceMode(s, () =>
    withViewContentTrace(t, s, descriptor, surface, async () => drag(s, plan, { capture: true })));
  const dragPalette = paletteWithMarkerColor(palette, traced.start?.markerColor, owner);
  const run = traced.action;
  const files = frames(run.frames);
  assert.equal(files.length, run.count, `${owner} drag recording omitted finalized frame files`);
  const captured = files.map(readFrame);
  assert.ok(captured.length > 2, `${owner} drag recording contains too few frames`);
  const firstGestureFrameIndex = captured.findIndex((frame) => frame.requested >= run.ticks[0]);
  const gestureEndedFrameIndex = captured.findIndex((frame) => frame.requested >= run.ticks.at(-1));
  assert.ok(firstGestureFrameIndex >= 0 && gestureEndedFrameIndex >= firstGestureFrameIndex,
    `${owner} drag capture does not cover the complete requested gesture`);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const root = viewDocumentRow(await s.get("host.window"), surface, owner);
  const targetRect = { x: root.frame.x, y: root.frame.y,
    width: root.frame.width, height: root.frame.height };
  const slotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface });
  const geometryFrames = [];
  for (let frameIndex = firstGestureFrameIndex; frameIndex <= gestureEndedFrameIndex; frameIndex++) {
    const measured = measureViewFrameGeometry(captured[frameIndex], { ...dragPalette, targetRect });
    geometryFrames.push({ frameIndex, timeMs: captured[frameIndex].requested,
      cardRectPt: measured.cardRectPt, nativeRectPt: measured.nativeRectPt, slotInsetsPt });
  }
  const tailGeometryFrames = [];
  for (let frameIndex = gestureEndedFrameIndex + 1; frameIndex < captured.length; frameIndex++) {
    const measured = measureViewFrameGeometry(captured[frameIndex], { ...dragPalette, targetRect });
    tailGeometryFrames.push(dragTailGeometryFrame(frameIndex, { ...measured,
      timeMs: captured[frameIndex].requested }, slotInsetsPt, owner));
  }
  const mapped = requireViewContentFrameCoverage(mapViewContentFramesToCapture(traced.contentFrames, captured), {
    gestureStartedAtMs: run.ticks[0], gestureEndedAtMs: run.ticks.at(-1),
  });
  const contentFrames = mapped.map((source) => {
    const displayCaptureIndex = captured.findIndex((frame) => frame.requested >= Math.max(run.displayed, source.timeRange.upperMs));
    return sourceContentFrame(source, source.frameIndex === null ? null : captured[source.frameIndex].requested,
      displayCaptureIndex < 0 ? null : { frameIndex: displayCaptureIndex, timeMs: captured[displayCaptureIndex].requested }, owner);
  });
  const finalRoot = viewDocumentRow(await s.get("host.window"), surface, owner);
  return {
    recordedFrameCount: captured.length,
    firstGestureFrameIndex,
    lastGestureFrameIndex: gestureEndedFrameIndex,
    gestureEndedFrameIndex,
    gestureStartedAtMs: run.ticks[0],
    phaseMode,
    gestureEndedAtMs: run.ticks.at(-1),
    finalPresentation: { displayedAtMs: run.displayed,
      targetViewport: { width: Math.trunc(finalRoot.frame.width), height: Math.trunc(finalRoot.frame.height) },
      targetRectPt: { left: finalRoot.frame.x, top: finalRoot.frame.y,
        right: finalRoot.frame.x + finalRoot.frame.width, bottom: finalRoot.frame.y + finalRoot.frame.height } },
    geometryFrames,
    tailGeometryFrames,
    contentFrames,
    sourceContentFrames: traced.contentFrames,
    rootSlotInsetsPt: slotInsetsPt,
    layouts: run.layouts,
    ticks: run.ticks,
    events: traced.events,
    captureDirectory: run.frames,
    missed: run.missed,
    late: run.late,
  };
}
