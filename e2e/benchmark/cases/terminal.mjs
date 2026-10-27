import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";

import { drag, keepCommonSettings } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, monotonicTimeMs,
  mapViewContentFramesToCapture, requireViewContentFrameCoverage, rightEdgeWidthDragPlan,
  rootNativePlacementBeforeCapture, selectOneShotViewSourceFrame,
  waitForViewReadiness, withViewContentTrace } from "../../view-metrics-collection.mjs";
import { firstContentFrame } from "../../view-first-content.mjs";
import { declaredSlotInsets, effectiveCardCornerRadiusPt, findFirstChangedSlotFrame, measureViewFrameGeometry,
  VIEW_GEOMETRY_COLOR_TOLERANCE }
  from "../../view-frame-geometry.mjs";
import { outside, terminalMarks } from "../../outside.mjs";
import { readScreenUntil } from "../../terminal-screen.mjs";
import { assertDragPerformance, assertHeldStatesShown, assertRoundTrips, measureDragPerformance,
  pointerLag, transactionCadence } from "../../drag-measurement.mjs";


/** Uses the fixed check-shell prompt as pixel evidence for the initial terminal content. */
export async function terminalFirstContentFrame({ captured, rect, directory, recognizeFrame }) {
  return firstContentFrame({ captured, rect, expected: "sh-3.2$", language: "en-US", directory, recognizeFrame });
}

/** Terminal content proof uses the initial fixture-shell prompt without adding a command or waiting on readiness as proof. */
export const terminalViewDescriptor = Object.freeze({
  plugin: "terminal",
  params: undefined,
  expectedContent: "sh-3.2$",
  language: "en-US",
  readinessStatus: "terminal.session",
  readiness: async (s, surface) => {
    const session = await s.until("terminal.session", (value) => value?.sessionId && value.cols > 0 && value.rows > 0,
      `terminal view ${surface} did not open its session`, { surface });
    const lines = await readScreenUntil(s, surface, (rows) => rows.some((line) => line.startsWith("sh-3.2$")),
      `terminal view ${surface} did not display its initial shell prompt`);
    const rect = await s.rect("terminal.view", undefined, surface);
    assert.ok(rect.width > 0 && rect.height > 0, `terminal view ${surface} has no visible content region`);
    const history = await s.run("terminal.view.history", {}, surface);
    assert.deepEqual(history, { length: 1 }, `terminal view ${surface} did not begin with one root history entry`);
    return { sessionId: session.sessionId, promptLines: lines, historyEntries: history.length, regionHistoryEntries: 0 };
  },
  readDocument: async (s, surface) => {
    const history = await s.run("terminal.view.history", {}, surface);
    return { historyEntries: history.length, regionHistoryEntries: 0 };
  },
  startContentTrace: async (s, surface) => {
    const result = await s.run("terminal.view.frames", { action: "start" }, surface);
    assert.equal(result?.enabled, true, `terminal view ${surface} content-frame observer did not start`);
    return result;
  },
  stopContentTrace: async (s, surface) => {
    const result = await s.run("terminal.view.frames", { action: "stop" }, surface);
    assert.deepEqual(result, { enabled: false }, `terminal view ${surface} content-frame observer did not stop`);
    return result;
  },
});

/** Persists the original drag transaction rows before any frame analysis can fail. */
export function writeTerminalDragLayouts(directory, layouts) {
  assert.ok(Array.isArray(layouts), "terminal drag layouts must be an array");
  const path = join(directory, "layouts.json");
  writeFileSync(path, JSON.stringify({ layouts }, null, 2) + "\n");
  return path;
}

/** Preserves the actual card and terminal raster rectangles measured in one captured frame. */
export function terminalDragGeometryFrame(frameIndex, measured, slotInsetsPt) {
  assert.ok(Number.isSafeInteger(frameIndex) && frameIndex >= 0, "terminal drag frame index is invalid");
  assert.ok(Number.isFinite(measured?.timeMs) && measured.timeMs >= 0, "terminal drag frame time is invalid");
  for (const name of ["cardRectPt", "nativeRectPt"]) {
    const rect = measured?.[name];
    assert.ok(rect && ["left", "top", "right", "bottom"].every((edge) => Number.isFinite(rect[edge]))
      && rect.right >= rect.left && rect.bottom >= rect.top, `terminal drag ${name} is invalid`);
  }
  assert.ok(slotInsetsPt && ["left", "top", "right", "bottom"].every((edge) =>
    Number.isFinite(slotInsetsPt[edge]) && slotInsetsPt[edge] >= 0), "terminal drag slot insets are invalid");
  return {
    frameIndex,
    timeMs: measured.timeMs,
    cardRectPt: measured.cardRectPt,
    nativeRectPt: measured.nativeRectPt,
    contentRectPt: measured.nativeRectPt,
    slotInsetsPt,
    contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}

/** Preserves one source document size update and its mapped capture time without assigning a native readback. */
export function terminalSourceContentFrame(source, displayFrame, displayCapture = null) {
  const frameIndex = source.frameIndex;
  if (frameIndex === null) {
    assert.equal(displayFrame, null, "uncaptured terminal source frame must not have a display frame");
  } else {
    assert.ok(Number.isSafeInteger(frameIndex) && frameIndex >= 0, "terminal source frame index is invalid");
    assert.ok(Number.isFinite(displayFrame?.time) && displayFrame.time >= source.timeRange.upperMs,
      "terminal source frame must map to a captured frame after its mapped interval");
  }
  assert.ok(Number.isFinite(source?.sequence) && source.sequence >= 0, "terminal source event sequence is invalid");
  assert.ok(Number.isFinite(source?.width) && source.width > 0 && Number.isFinite(source?.height) && source.height > 0,
    "terminal source content dimensions are invalid");
  assert.ok(Number.isFinite(source?.source?.documentTimeOriginMs) && source.source.documentTimeOriginMs > 0,
    "terminal source frame has no document clock origin");
  return {
    sourceSequence: source.sequence,
    frameIndex,
    frameTimeMs: source.frameTimeMs,
    captureTimeMs: displayFrame?.time ?? null,
    displayCapture,
    timeRange: source.timeRange,
    width: source.width,
    height: source.height,
    source: {
      sequence: source.sequence,
      firstResizeAtMs: source.firstResizeAtMs,
      resizeAtMs: source.resizeAtMs,
      resizeCount: source.resizeCount,
      frameTimeMs: source.frameTimeMs,
      documentTimeOriginMs: source.source.documentTimeOriginMs,
      eventTsUs: source.source?.eventTsUs,
      eventMonoNs: source.source?.eventMonoNs,
    },
    displayTimeMs: displayFrame?.time ?? null,
  };
}

// Keep measured content outside the color tolerance of the card's antialiased focus outline.
export const TERMINAL_GEOMETRY_BACKGROUND = Object.freeze([0, 80, 180]);

const TERMINAL_GEOMETRY = Object.freeze({ contentColor: TERMINAL_GEOMETRY_BACKGROUND, cardColor: [25, 27, 36],
  planeColor: [16, 17, 23], borderColors: [[43, 46, 61], [34, 36, 47], [255, 179, 107]], colorTolerance: 3 });

/** Applies the terminal measurement color through OSC 11 and waits for its output marker in the rendered screen. */
export async function setTerminalGeometryBackground(session, surface) {
  const hex = TERMINAL_GEOMETRY_BACKGROUND.map((value) => value.toString(16).padStart(2, "0")).join("/");
  const marker = `TERMINAL-GEOMETRY-${surface}`;
  await session.run("terminal.input", { bytes: `printf '\\033]11;rgb:${hex}\\007${marker}\\n'\r` }, surface);
  await readScreenUntil(session, surface, (lines) => lines.some((line) => line.startsWith(marker)),
    `${surface} did not finish the terminal geometry background change`);
}

/** Measures terminal content geometry with the exact palette used by its layout and drag collectors. */
export function measureTerminalLayoutFrame(frame, { cornerRadiusPt, targetRect } = {}) {
  return measureViewFrameGeometry(frame, { ...TERMINAL_GEOMETRY, cornerRadiusPt, targetRect });
}

function terminalDocument(host, surface) {
  const row = host.documents.find((document) => document.surface === surface && document.document === "");
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `terminal view ${surface} has no visible root document frame`);
  return row;
}

/** Returns the declared native raster region rectangle from host.window. */
export function terminalRasterTargetRectPt(host, surface) {
  const regions = host?.regions?.filter((region) => region.surface === surface && region.name === "view") ?? [];
  assert.equal(regions.length, 1, `terminal view ${surface} must have exactly one native raster region`);
  const region = regions[0];
  const frame = region.frame;
  assert.ok(region.visible && frame && [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)
    && frame.width > 0 && frame.height > 0,
  `terminal view ${surface} has no visible native raster region frame`);
  return { left: frame.x, top: frame.y, right: frame.x + frame.width, bottom: frame.y + frame.height };
}

async function terminalSlotInsets(s, card, surface) {
  const [grid, surfaces, rect] = await Promise.all([
    s.get("core.grid"), s.get("core.surfaces"), s.rect("terminal.view", undefined, surface),
  ]);
  return declaredSlotInsets({ grid, surfaces, card, surface,
    regionRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
}

function frameAtOrAfter(captured, timeMs, description) {
  const index = captured.findIndex((frame) => frame.time >= timeMs);
  assert.ok(index >= 0, `${description} has no captured display frame at or after ${timeMs} ms`);
  return index;
}

async function terminalLayoutObservation(t, s, descriptor, surface, card, directory, cornerRadiusPt) {
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () => {
    const recording = await s.record();
    const grid = await s.get("core.grid");
    const current = grid.cards.find((item) => item.id === card);
    assert.ok(current && Number.isFinite(current.w), `terminal measurement card ${card} has no current width`);
    const beforeChangeTimeMs = (await monotonicTimeMs(s)).timeMs;
    await s.run("core.grid.size", { card, axis: "x", size: current.w + 80 });
    const { displayed } = await s.presented();
    const capture = await recording.stop({ after: displayed });
    return { beforeChangeTimeMs, displayed, capture };
  });
  const { beforeChangeTimeMs, displayed, capture } = traced.action;
  assert.equal(capture.limited, false, "terminal layout recording reached its bounded frame limit");
  const paths = frames(capture.frames);
  assert.equal(paths.length, capture.count, "terminal layout recording omitted a frame file");
  assert.ok(paths.length > 0, "terminal layout recording contains no frames");
  const path = join(directory, "layout.json");
  const decoded = paths.map(readFrame);
  writeFileSync(path, JSON.stringify({ beforeChangeTimeMs, displayed, contentFrames: traced.contentFrames,
    events: traced.events, frameFiles: paths, frameTimes: decoded.map(({ time }) => time),
    captureDirectory: capture.frames }, null, 2) + "\n");
  const host = await s.get("host.window");
  const root = terminalDocument(host, surface);
  const nativePlacement = rootNativePlacementBeforeCapture(traced.events, surface, displayed,
    { afterMs: beforeChangeTimeMs });
  const sourceSelection = selectOneShotViewSourceFrame(traced.contentFrames,
    { requestAtMs: beforeChangeTimeMs, nativePlacement });
  const source = sourceSelection.frame;
  assert.ok(source, `terminal observer has no source frame matching its final post-request native placement projection: ${JSON.stringify(sourceSelection.failure)}`);
  const slotInsetsPt = await terminalSlotInsets(s, card, surface);
  const targetRect = { x: root.frame.x, y: root.frame.y,
    width: root.frame.width, height: root.frame.height };
  const measured = decoded.map((frame) => measureTerminalLayoutFrame(frame, { cornerRadiusPt, targetRect }));
  const transition = findFirstChangedSlotFrame(measured, { beforeChangeTimeMs, slotInsetsPt });
  const captureAfter = Math.max(displayed, source.timeRange.upperMs);
  const candidates = transition.slotMatchFrameIndices.filter((index) => decoded[index].time >= captureAfter);
  assert.ok(candidates.length > 0, `terminal layout has no declared-slot pixel match at or after ${captureAfter} ms`);
  const proof = await firstContentFrame({ captured: candidates.map((index) => decoded[index]),
    rect: { x: root.frame.x, y: root.frame.y, w: root.frame.width, h: root.frame.height },
    expected: descriptor.expectedContent, language: descriptor.language, directory: capture.frames });
  const frameIndex = candidates[proof.frameIndex];
  const geometry = measured[frameIndex];
  return {
    changeFrame: { frameIndex: transition.changeFrameIndex, frameCount: decoded.length,
      timeMs: decoded[transition.changeFrameIndex].time },
    contentFrame: { frameIndex, frameCount: decoded.length, timeMs: decoded[frameIndex].time,
      requestAtMs: beforeChangeTimeMs, displayedAtMs: displayed, sourceTimeRange: source.timeRange,
      width: source.width, height: source.height, nativePlacement,
      surfaceEvents: traced.events.filter((event) => event?.event === "host.trace.surface" && event.fields?.surface === surface),
      proof: proof.proof },
    sourceFrame: source,
    initialGeometry: { frameIndex, timeMs: decoded[frameIndex].time, cardRectPt: geometry.cardRectPt,
      nativeRectPt: geometry.nativeRectPt, slotInsetsPt },
    events: traced.events,
    captureDirectory: capture.frames,
    evidencePath: path,
  };
}

async function terminalDragObservation(t, s, descriptor, surface, card, configDir, cornerRadiusPt) {
  const beforeGrid = await s.get("core.grid");
  const pane = beforeGrid.cards.find((item) => item.id === card);
  assert.ok(pane, `terminal measurement card ${card} is absent before drag`);
  const plan = rightEdgeWidthDragPlan(beforeGrid, pane);
  await s.presented();
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () =>
    drag(t, s, plan, { capture: true }));
  const run = traced.action;
  mkdirSync(join(configDir, "logs"), { recursive: true });
  const directory = mkdtempSync(join(configDir, "logs", "terminal-view-drag-"));
  writeTerminalDragLayouts(directory, run.layouts);
  const files = frames(run.frames);
  assert.equal(files.length, run.count, "terminal view drag recording omitted finalized frame files");
  writeFileSync(join(directory, "source-frames.json"), JSON.stringify({
    rawEvents: traced.events, contentFrames: traced.contentFrames, frameFiles: files, frameIdentity: run.frameIdentity ?? null,
  }, null, 2) + "\n");
  const captured = files.map(readFrame);
  assert.ok(captured.length > 2, "terminal view drag recording contains too few frames");
  const firstGestureFrameIndex = frameAtOrAfter(captured, run.ticks[0], "terminal drag start");
  const gestureEndedFrameIndex = frameAtOrAfter(captured, run.ticks.at(-1), "terminal drag end");
  assert.ok(gestureEndedFrameIndex >= firstGestureFrameIndex,
    "terminal drag recording does not cover the complete requested gesture");
  const slotInsetsPt = await terminalSlotInsets(s, card, surface);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const rootSlotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface });
  const root = terminalDocument(await s.get("host.window"), surface);
  const targetRect = { x: root.frame.x, y: root.frame.y,
    width: root.frame.width, height: root.frame.height };
  const geometryFrames = [];
  for (let frameIndex = firstGestureFrameIndex; frameIndex <= gestureEndedFrameIndex; frameIndex++) {
    const measured = measureTerminalLayoutFrame(captured[frameIndex], { cornerRadiusPt, targetRect });
    geometryFrames.push(terminalDragGeometryFrame(frameIndex, measured, slotInsetsPt));
  }
  const tailGeometryFrames = [];
  for (let frameIndex = gestureEndedFrameIndex + 1; frameIndex < captured.length; frameIndex++) {
    const measured = measureTerminalLayoutFrame(captured[frameIndex], { cornerRadiusPt, targetRect });
    tailGeometryFrames.push(terminalDragGeometryFrame(frameIndex, measured, slotInsetsPt));
  }

  const mapped = requireViewContentFrameCoverage(mapViewContentFramesToCapture(traced.contentFrames, captured), {
    gestureStartedAtMs: run.ticks[0], gestureEndedAtMs: run.ticks.at(-1),
  });
  const sourceFrames = mapped.map((source) => {
    const displayCaptureIndex = captured.findIndex((frame) => frame.time >= Math.max(run.displayed, source.timeRange.upperMs));
    return terminalSourceContentFrame(source, source.frameIndex === null ? null : captured[source.frameIndex],
      displayCaptureIndex < 0 ? null : { frameIndex: displayCaptureIndex, timeMs: captured[displayCaptureIndex].time });
  });
  writeFileSync(join(directory, "source-frames.json"), JSON.stringify({
    frames: sourceFrames, rawEvents: traced.events, contentFrames: traced.contentFrames,
    frameFiles: files, capturedFrameTimes: captured.map(({ time }) => time), frameIdentity: run.frameIdentity ?? null,
  }, null, 2) + "\n");
  const finalHost = await s.get("host.window");
  const finalRoot = terminalDocument(finalHost, surface);
  return {
    recordedFrameCount: captured.length,
    firstGestureFrameIndex,
    lastGestureFrameIndex: gestureEndedFrameIndex,
    gestureEndedFrameIndex,
    gestureStartedAtMs: run.ticks[0],
    gestureEndedAtMs: run.ticks.at(-1),
    finalPresentation: { displayedAtMs: run.displayed,
      targetViewport: { width: Math.trunc(finalRoot.frame.width), height: Math.trunc(finalRoot.frame.height) },
      targetRectPt: terminalRasterTargetRectPt(finalHost, surface) },
    geometryFrames,
    tailGeometryFrames,
    contentFrames: sourceFrames,
    sourceContentFrames: traced.contentFrames,
    rootSlotInsetsPt,
    layouts: run.layouts,
    ticks: run.ticks,
    events: traced.events,
    captureDirectory: run.frames,
    evidenceDirectory: directory,
  };
}

/** Collects the terminal lifecycle, initial-prompt pixels, source-frame sizes and measured drag geometry. */
export async function collectTerminalViewMeasurements(t, s, descriptor, configDir) {
  const start = await collectViewStartAndMemory(t, s, descriptor);
  const cornerRadiusPt = effectiveCardCornerRadiusPt((await s.get("core.settings")).values);
  const split = await s.run("core.card.split", { card: start.card, side: "right", plugin: descriptor.plugin });
  const surface = split.tab;
  const card = split.card;
  s.cleanup(async () => {
    const grid = await s.get("core.grid");
    if (!grid.cards.some((item) => item.id === card)) return;
    const result = await s.run("core.card.close", { card });
    assert.equal(result?.closed, true, `terminal measurement card ${card} did not close during cleanup`);
    await s.until("core.grid", (value) => !value.cards.some((item) => item.id === card),
      `terminal measurement card ${card} remained during cleanup`);
  });
  const readinessEvidence = await waitForViewReadiness(s, surface, descriptor);
  assert.equal(readinessEvidence.historyEntries, 1, `terminal view ${surface} did not begin at initial history`);
  await setTerminalGeometryBackground(s, surface);
  mkdirSync(join(configDir, "logs"), { recursive: true });
  const directory = mkdtempSync(join(configDir, "logs", "terminal-view-layout-"));
  const layout = await terminalLayoutObservation(t, s, descriptor, surface, card, directory, cornerRadiusPt);
  const dragEvidence = await terminalDragObservation(t, s, descriptor, surface, card, configDir, cornerRadiusPt);
  const closed = await s.run("core.tab.close", { tab: surface });
  assert.equal(closed?.closed, true, `terminal measurement view ${surface} did not close after capture`);
  await s.until("core.surfaces", (items) => !items.some((item) => item.surface === surface),
    `terminal measurement view ${surface} remained after capture`);
  const evidence = { events: [...start.events, ...layout.events, ...dragEvidence.events],
    recordings: [...start.recordings, { directory: layout.captureDirectory }, { directory: dragEvidence.captureDirectory }] };
  const reclaim = await collectViewReclaimMeasurements(t, s, descriptor, start.opened, evidence);
  return {
    plugin: descriptor.plugin,
    host: s.app.name,
    total: start.total,
    reclaim,
    warmDisplay: start.warmDisplay,
    newProcess: { processStarts: start.processStarts, firstDisplays: start.firstDisplays },
    layoutDisplay: [layout],
    drag: dragEvidence,
    _evidence: { ...evidence, layoutDirectory: directory, dragDirectory: dragEvidence.evidenceDirectory },
  };
}

/** Runs the existing untraced terminal drag capture and returns its exact pixel and transaction evidence. */
export async function collectTerminalDrag(t, s, terminal, configDir) {
  assert.equal(process.env.SOKSAK_PERFORMANCE_TRACE, undefined,
    "the benchmark requires performance tracing to be unset");
  assert.equal(process.env.SOKSAK_VT_TRACE_DIR, undefined,
    "the benchmark requires renderer tracing to be unset");
  const { values } = await s.get("core.settings");
  const cornerRadiusPt = effectiveCardCornerRadiusPt(values);
  assert.equal(values["diagnostics.performance"], false, "the application performance trace is enabled");
  assert.deepEqual(values["diagnostics.log"], {}, "the application is not using its default error-only log policy");
  assert.equal((await s.get("terminal.cursor", terminal.surface)).render, null,
    "the renderer trace is enabled in the application");
  await keepCommonSettings(s);
  await s.run("core.settings.link", { place: "window-right", plugin: "terminal", set: "set-install", scope: "common" });
  await s.until("core.rail", (rail) => rail.groups.length === 1, "the terminal override drew no rail");
  const marks = { ...await terminalMarks(s), colour: TERMINAL_GEOMETRY_BACKGROUND };
  await readScreenUntil(s, terminal.surface, (lines) => lines.some((line) => line.includes("$")),
    `${terminal.surface} did not show a shell prompt before the geometry measurement`);
  await setTerminalGeometryBackground(s, terminal.surface);
  await s.presented();
  const grid = await s.get("core.grid");
  const card = grid.cards.find((item) => item.active);
  assert.ok(card?.id, "terminal drag benchmark has no active card");
  const slotInsetsPt = await terminalSlotInsets(s, card.id, terminal.surface);
  const root = terminalDocument(await s.get("host.window"), terminal.surface);
  const targetRect = { x: root.frame.x, y: root.frame.y,
    width: root.frame.width, height: root.frame.height };
  const run = await drag(t, s, { axis: "x", line: 1, dx: 250, dy: 0, ms: 400, times: 2 }, { capture: true });
  mkdirSync(join(configDir, "logs"), { recursive: true });
  const directory = mkdtempSync(join(configDir, "logs", "view-drag-benchmark-"));
  writeTerminalDragLayouts(directory, run.layouts);
  const files = frames(run.frames);
  assert.equal(files.length, run.count, "the benchmark recording omitted a frame file");
  assert.ok(files.length > 30, "the benchmark has too few captured frames");

  const samples = [];
  const times = [];
  const unmeasured = [];
  const geometryFrames = [];
  const geometryUnmeasured = [];
  for (const [frameIndex, file] of files.entries()) {
    const frame = readFrame(file);
    times.push(frame.time);
    try {
      const geometry = measureViewFrameGeometry(frame, { ...TERMINAL_GEOMETRY,
        colorTolerance: VIEW_GEOMETRY_COLOR_TOLERANCE, cornerRadiusPt, targetRect });
      geometryFrames.push(terminalDragGeometryFrame(frameIndex, geometry, slotInsetsPt));
    } catch (error) {
      geometryUnmeasured.push({ frameIndex, error: error.message });
    }
    const at = outside(frame, marks);
    if (!at) {
      unmeasured.push(frameIndex);
      continue;
    }
    samples.push({ time: frame.time, position: at.card.l / at.scale });
  }
  assert.ok(samples.length > files.length * 0.5,
    `only ${samples.length}/${files.length} frames have measured geometry`);
  assertRoundTrips(samples.map((sample) => sample.position), 2);
  assertHeldStatesShown(samples, run.ticks, run.boundary);
  const lag = pointerLag(samples, run.ticks, run.boundary);
  const refreshRate = (await s.get("host.window")).refreshRate;
  const performance = measureDragPerformance(times, lag, refreshRate);
  const report = {
    host: s.app.name,
    performance,
    mode: { performanceTrace: false, rendererTrace: false, logPolicy: {}, recording: true },
    load: loadavg(),
    processors: availableParallelism(),
    frameCount: files.length,
    unmeasured,
    samples,
    times,
    ticks: run.ticks,
    boundary: run.boundary,
    layouts: run.layouts,
    transactionCadence: transactionCadence(run.layouts),
  };
  return {
    directory,
    report,
    drag: {
      recordedFrameCount: files.length,
      geometryFrames,
      geometryUnmeasured,
      layouts: run.layouts,
      ticks: run.ticks,
    },
    assertPerformance: () => assertDragPerformance(times, lag, refreshRate),
  };
}
