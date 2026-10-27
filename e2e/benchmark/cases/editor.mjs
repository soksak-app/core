import assert from "node:assert/strict";

import { drag } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { firstContentFrame } from "../../view-first-content.mjs";
import { declaredSlotInsets, effectiveCardCornerRadiusPt, findFirstChangedSlotFrame, measureViewFrameGeometry }
  from "../../view-frame-geometry.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, mapViewContentFramesToCapture, monotonicTimeMs,
  selectOneShotViewSourceFrame, viewCardWithDifferentPluginTab, viewFootprints,
  requireViewContentFrameCoverage, rootNativePlacementBeforeCapture,
  withViewContentTrace } from "../../view-metrics-collection.mjs";
import { viewContentCases } from "../../view-content.mjs";
import { viewProcessGroup } from "../../view-process-footprint.mjs";

/** Measures the complete OS process group attached to selected editor view surfaces. */
export async function collectEditorProcessFootprint(s, surfaces, measureFootprint) {
  const host = await s.get("host.window");
  const group = viewProcessGroup(host, surfaces);
  const processes = await viewFootprints(host, surfaces, measureFootprint);
  assert.deepEqual(processes.map(({ pid }) => pid), group.pids,
    "editor footprint samples do not cover the complete process-sharing group");
  return { pids: group.pids, surfaces: group.surfaces, processes };
}

/** Converts the normal and hidden-only process-group samples into measured editor bytes. */
export function editorFootprintEvidence(viewProcesses, hiddenProcesses, fixture, { documentLength, lines }) {
  assertProcessRows(viewProcesses, "normal view");
  assertProcessRows(hiddenProcesses, "hidden-only view");
  assert.deepEqual(Object.keys(fixture ?? {}).sort(), ["documentLength", "historyEntries", "lines", "mounted", "regionHistoryEntries"],
    "hidden-only editor view returned unexpected measurement fields");
  assert.equal(fixture.mounted, true, "hidden editor fixture is not mounted");
  assert.equal(fixture.documentLength, documentLength, "hidden editor fixture copied an unexpected document length");
  assert.equal(fixture.lines, lines, "hidden editor fixture reports an unexpected line count");
  assert.equal(fixture.historyEntries, 1, "hidden editor fixture history contains entries beyond its initial document");
  assert.equal(fixture.regionHistoryEntries, 0, "hidden editor fixture unexpectedly attached a native document region");
  const viewBytes = viewProcesses.reduce((sum, row) => sum + row.footprintBytes, 0);
  const hiddenDomBytes = hiddenProcesses.reduce((sum, row) => sum + row.footprintBytes, 0);
  assert.ok(Number.isSafeInteger(viewBytes) && Number.isSafeInteger(hiddenDomBytes), "editor footprint sum is not a safe integer");
  return { viewBytes, hiddenDomBytes };
}

function assertProcessRows(rows, label) {
  assert.ok(Array.isArray(rows) && rows.length > 0, `editor footprint requires nonempty ${label} process samples`);
  assert.equal(new Set(rows.map((row) => row?.pid)).size, rows.length, `editor footprint ${label} PIDs must be unique`);
  for (const row of rows) {
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0, `editor footprint ${label} PID is invalid`);
    assert.ok(Number.isSafeInteger(row.footprintBytes) && row.footprintBytes > 0,
      `editor footprint ${label} value for ${row.pid} is invalid`);
  }
}

/** Opens and measures one diagnostic-only Editor view after all normal Editor views have closed. */
export async function collectHiddenEditorFootprint(s, viewProcesses, measureFootprint) {
  const existing = await s.get("core.surfaces");
  assert.deepEqual(existing.filter((item) => item.plugin === "editor").map((item) => item.surface), [],
    "hidden-only Editor measurement requires all normal Editor views to be closed");
  const grid = await s.get("core.grid");
  const activeCard = grid.cards.find((item) => item.active);
  const card = viewCardWithDifferentPluginTab(grid, "editor", activeCard?.id);
  const document = "SOKSAK EDITOR CONTENT\n";
  const { tab: surface } = await s.run("core.card.add-tab", { card, plugin: "editor",
    params: { diagnosticMode: "hidden-memory", document } });
  assert.ok(typeof surface === "string" && surface.length > 0, "hidden-only Editor tab has no surface identity");

  let commandReady = false;
  let result;
  let operationError;
  try {
    const registered = await s.until("core.surfaces", (items) => items.some((item) => item.surface === surface
      && (item.exposes?.includes("command editor.memory.hidden") || item.status?.phase === "error")),
    `hidden-only Editor view ${surface} did not register its memory command`);
    const entry = registered.find((item) => item.surface === surface);
    assert.ok(entry, `hidden-only Editor view ${surface} disappeared before measurement`);
    assert.equal(entry.plugin, "editor", `hidden-only Editor view ${surface} has the wrong plugin identity`);
    assert.ok(entry.exposes?.includes("command editor.memory.hidden"),
      `hidden-only Editor view ${surface} failed before exposing its memory command: ${JSON.stringify(entry.status)}`);
    commandReady = true;
    const fixture = await s.run("editor.memory.hidden", { action: "read" }, surface);
    assert.equal(fixture.documentLength, document.length, "hidden-only Editor view has an unexpected document length");
    assert.equal(fixture.lines, 2, "hidden-only Editor view has an unexpected line count");
    const surfaces = await s.get("core.surfaces");
    assert.deepEqual(surfaces.filter((item) => item.plugin === "editor").map((item) => item.surface), [surface],
      "hidden-only Editor measurement has another live Editor view");
    const host = await s.get("host.window");
    const group = viewProcessGroup(host, [surface]);
    assert.deepEqual(group.surfaces, [surface],
      "hidden-only Editor process group is shared with another live surface");
    assert.deepEqual(group.documents.map(({ document: name }) => name), [""],
      "hidden-only Editor process group has an attached native document process");
    const measured = await collectEditorProcessFootprint(s, [surface], measureFootprint);
    assert.deepEqual(measured.pids, group.pids, "hidden-only Editor process group changed during footprint sampling");
    assert.deepEqual(measured.surfaces, [surface], "hidden-only Editor process group gained another live surface");
    const editorFootprint = editorFootprintEvidence(viewProcesses, measured.processes, fixture,
      { documentLength: document.length, lines: 2 });
    result = { editorFootprint, evidence: { surface, processGroupPids: measured.pids,
      processGroupSurfaces: measured.surfaces, viewProcesses, hiddenProcesses: measured.processes, fixture } };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  if (commandReady) {
    try {
      const removed = await s.run("editor.memory.hidden", { action: "remove" }, surface);
      assert.equal(removed.mounted, false, "hidden-only Editor view remained mounted after remove");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    const registered = await s.get("core.surfaces");
    if (registered.some((item) => item.surface === surface)) {
      const closed = await s.run("core.tab.close", { tab: surface });
      assert.equal(closed?.closed, true, `hidden-only Editor view ${surface} did not close`);
      await s.until("core.surfaces", (items) => !items.some((item) => item.surface === surface),
        `hidden-only Editor view ${surface} remained registered after close`);
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([operationError, ...cleanupErrors], "hidden-only Editor measurement and cleanup failed", { cause: operationError });
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "hidden-only Editor cleanup failed");
  return result;
}

/** Derives slot inset values from the declared surface and card geometry, never from capture pixels. */
export function editorSlotInsets(grid, surfaces, cardId, surfaceId) {
  return declaredSlotInsets({ grid, surfaces, card: cardId, surface: surfaceId });
}

/** Derives the Editor content region inset from its declared DOM rectangle. */
export function editorContentSlotInsets(grid, surfaces, cardId, surfaceId, regionRect) {
  return declaredSlotInsets({ grid, surfaces, card: cardId, surface: surfaceId,
    regionRect: { x: regionRect.x, y: regionRect.y, w: regionRect.width, h: regionRect.height } });
}

function editorFrameGeometry(frame, palette, targetRect) {
  return measureViewFrameGeometry(frame, { ...palette, targetRect });
}

function editorDocumentRow(host, surface) {
  const row = host.documents.find((item) => item.surface === surface && item.document === "");
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `editor surface ${surface} has no visible view document frame`);
  return row;
}

/** Preserves source dimensions and the capture frame that proves its display. */
export function editorSourceContentFrame(source, captureTimeMs, displayCapture = null) {
  assert.ok(Number.isSafeInteger(source?.sourceSequence) && source.sourceSequence >= 0,
    "editor source frame has an invalid sequence");
  assert.ok(Number.isFinite(source?.frameTimeMs) && source.frameTimeMs >= 0
    && Number.isFinite(source?.timeRange?.lowerMs) && Number.isFinite(source?.timeRange?.upperMs)
    && source.timeRange.lowerMs <= source.timeRange.upperMs, "editor source frame has invalid timing evidence");
  assert.ok(Number.isFinite(source?.width) && source.width > 0
    && Number.isFinite(source?.height) && source.height > 0, "editor source frame has invalid dimensions");
  if (source.frameIndex === null) {
    assert.equal(captureTimeMs, null, "uncaptured editor source frame must not have a capture timestamp");
  } else {
    assert.ok(Number.isSafeInteger(source.frameIndex) && source.frameIndex >= 0,
      "editor source frame has an invalid capture index");
    assert.ok(Number.isFinite(captureTimeMs) && captureTimeMs >= source.timeRange.upperMs,
      "editor source frame capture must be at or after its source interval");
  }
  return { sourceSequence: source.sourceSequence, frameIndex: source.frameIndex, frameTimeMs: source.frameTimeMs,
    captureTimeMs, displayCapture, timeRange: source.timeRange, width: source.width, height: source.height, source };
}

async function editorLayoutObservation(t, s, descriptor, surface, card, theme, cornerRadiusPt) {
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () => {
    const recording = await s.record();
    const grid = await s.get("core.grid");
    const pane = grid.cards.find((item) => item.id === card);
    assert.ok(pane && Number.isFinite(pane.w), `editor measurement card ${card} has no current width`);
    const beforeRoot = editorDocumentRow(await s.get("host.window"), surface);
    const beforeChangeTimeMs = (await monotonicTimeMs(s)).timeMs;
    await s.run("core.grid.size", { card, axis: "x", size: pane.w + 80 });
    const { displayed } = await s.presented();
    const result = await recording.stop({ after: displayed });
    assert.equal(result.limited, false, "editor layout recording reached its bounded frame limit");
    const files = frames(result.frames);
    assert.equal(files.length, result.count, "editor layout recording omitted finalized frame files");
    assert.ok(files.length > 0, "editor layout recording contains no frames");
    return { displayed, beforeChangeTimeMs, result, captured: files.map(readFrame), paletteRect: beforeRoot.frame };
  });
  const { beforeChangeTimeMs, displayed, result, captured, paletteRect } = traced.action;
  const host = await s.get("host.window");
  const root = editorDocumentRow(host, surface);
  const palette = editorGeometryPalette(captured[0], paletteRect, theme, cornerRadiusPt);
  const nativePlacement = rootNativePlacementBeforeCapture(traced.events, surface, displayed,
    { afterMs: beforeChangeTimeMs });
  const sourceSelection = selectOneShotViewSourceFrame(traced.contentFrames,
    { requestAtMs: beforeChangeTimeMs, nativePlacement });
  const source = sourceSelection.frame;
  assert.ok(source, `editor source has no frame matching its final post-request native placement projection: ${JSON.stringify(sourceSelection.failure)}`);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const targetRect = { x: root.frame.x, y: root.frame.y,
    width: root.frame.width, height: root.frame.height };
  const slotInsetsPt = editorSlotInsets(grid, surfaces, card, surface);
  const measured = captured.map((frame) => editorFrameGeometry(frame, palette, targetRect));
  const transition = findFirstChangedSlotFrame(measured, { beforeChangeTimeMs, slotInsetsPt });
  const captureAfter = Math.max(displayed, source.timeRange.upperMs);
  const candidates = transition.slotMatchFrameIndices.filter((index) => captured[index].time >= captureAfter);
  assert.ok(candidates.length > 0, `editor layout has no declared-slot pixel match at or after ${captureAfter} ms`);
  const localProof = await firstContentFrame({ captured: candidates.map((index) => captured[index]),
    rect: { x: root.frame.x, y: root.frame.y, w: root.frame.width, h: root.frame.height },
    expected: descriptor.expectedContent, language: descriptor.language, directory: result.frames });
  const frameIndex = candidates[localProof.frameIndex];
  const geometry = measured[frameIndex];
  return {
    changeFrame: { frameIndex: transition.changeFrameIndex, frameCount: captured.length,
      timeMs: captured[transition.changeFrameIndex].time },
    contentFrame: { frameIndex, frameCount: captured.length, timeMs: captured[frameIndex].time,
      requestAtMs: beforeChangeTimeMs, displayedAtMs: displayed, sourceTimeRange: source.timeRange,
      width: source.width, height: source.height, nativePlacement,
      surfaceEvents: traced.events.filter((event) => event?.event === "host.trace.surface" && event.fields?.surface === surface),
      proof: localProof.proof },
    sourceFrame: source,
    slotInsetsPt,
    initialGeometry: { frameIndex, timeMs: captured[frameIndex].time, cardRectPt: geometry.cardRectPt,
      nativeRectPt: geometry.nativeRectPt, slotInsetsPt },
    pixelPalette: palette,
    events: traced.events,
    captureDirectory: result.frames,
  };
}

async function editorDragObservation(t, s, descriptor, surface, card, palette) {
  await s.presented();
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () =>
    drag(t, s, { axis: "x", line: 1, dx: 80, dy: 0, ms: 500, times: 1 }, { capture: true }));
  const run = traced.action;
  const files = frames(run.frames);
  assert.equal(files.length, run.count, "editor drag recording omitted finalized frame files");
  const captured = files.map(readFrame);
  assert.ok(captured.length > 2, "editor drag recording contains too few frames");
  const firstGestureFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks[0]);
  const gestureEndedFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks.at(-1));
  assert.ok(firstGestureFrameIndex >= 0 && gestureEndedFrameIndex >= firstGestureFrameIndex,
    "editor drag capture does not cover the complete requested gesture");
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const root = editorDocumentRow(await s.get("host.window"), surface);
  const targetRect = { x: root.frame.x, y: root.frame.y,
    width: root.frame.width, height: root.frame.height };
  const slotInsetsPt = editorSlotInsets(grid, surfaces, card, surface);
  const contentRect = targetRect;
  const rootSlotInsetsPt = slotInsetsPt;
  const geometryFrames = [];
  for (let frameIndex = firstGestureFrameIndex; frameIndex <= gestureEndedFrameIndex; frameIndex++) {
    const measured = editorFrameGeometry(captured[frameIndex], palette, contentRect);
    geometryFrames.push({ frameIndex, timeMs: captured[frameIndex].time,
      cardRectPt: measured.cardRectPt, nativeRectPt: measured.nativeRectPt, slotInsetsPt });
  }
  const mapped = requireViewContentFrameCoverage(mapViewContentFramesToCapture(traced.contentFrames, captured), {
    gestureStartedAtMs: run.ticks[0], gestureEndedAtMs: run.ticks.at(-1),
  });
  const contentFrames = mapped.map((source) => {
    const displayCaptureIndex = captured.findIndex((frame) => frame.time >= Math.max(run.displayed, source.timeRange.upperMs));
    return editorSourceContentFrame(source, source.frameIndex === null ? null : captured[source.frameIndex].time,
      displayCaptureIndex < 0 ? null : { frameIndex: displayCaptureIndex, timeMs: captured[displayCaptureIndex].time });
  });
  const finalRoot = editorDocumentRow(await s.get("host.window"), surface);
  return {
    recordedFrameCount: captured.length,
    firstGestureFrameIndex,
    lastGestureFrameIndex: gestureEndedFrameIndex,
    gestureEndedFrameIndex,
    gestureStartedAtMs: run.ticks[0],
    gestureEndedAtMs: run.ticks.at(-1),
    finalPresentation: { displayedAtMs: run.displayed,
      targetViewport: { width: Math.trunc(finalRoot.frame.width), height: Math.trunc(finalRoot.frame.height) } },
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

/** Measures layout presentation and a full card drag using actual editor capture pixels. */
export async function collectEditorMotionMeasurements(t, s, prepared) {
  const surface = prepared.start.warmDisplay.surface;
  const layoutDisplay = await editorLayoutObservation(t, s, prepared.descriptor, surface,
    prepared.start.card, prepared.theme, prepared.cornerRadiusPt);
  const drag = await editorDragObservation(t, s, prepared.descriptor, surface,
    prepared.start.card, layoutDisplay.pixelPalette);
  return { layoutDisplay: [layoutDisplay], drag,
    evidence: { events: [...layoutDisplay.events, ...drag.events],
      recordings: [{ directory: layoutDisplay.captureDirectory }, { directory: drag.captureDirectory }],
      pixelPalette: layoutDisplay.pixelPalette } };
}

/** Derives an opaque editor-fill palette from the interior, rejecting core geometry colors. */
export function editorGeometryPalette(frame, rect, theme, cornerRadiusPt) {
  assert.ok(frame && frame.data instanceof Uint8Array && frame.data.length === frame.stride * frame.height,
    "editor palette requires a complete decoded frame");
  assert.ok(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0, "editor palette requires a visible document rectangle");
  assert.ok(theme && typeof theme === "object", "editor palette requires the active core theme");
  assert.ok(Number.isFinite(cornerRadiusPt) && cornerRadiusPt >= 0,
    "editor palette requires the effective core card radius");
  const ratio = frame.scale * frame.contentScale;
  const left = Math.floor(frame.content.x * frame.scale + (rect.x + rect.width * 0.2) * ratio);
  const top = Math.floor(frame.content.y * frame.scale + (rect.y + rect.height * 0.2) * ratio);
  const right = Math.ceil(frame.content.x * frame.scale + (rect.x + rect.width * 0.8) * ratio);
  const bottom = Math.ceil(frame.content.y * frame.scale + (rect.y + rect.height * 0.8) * ratio);
  assert.ok(left >= 0 && top >= 0 && right <= frame.width && bottom <= frame.height && right > left && bottom > top,
    "editor palette sampling rectangle lies outside the decoded frame");
  const counts = new Map();
  let sampled = 0;
  for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
    const offset = y * frame.stride + x * 4;
    if (frame.data[offset + 3] !== 255) continue;
    const color = [frame.data[offset + 2], frame.data[offset + 1], frame.data[offset]];
    const key = color.join(",");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    sampled++;
  }
  assert.ok(sampled > 0, "editor palette interior contains no opaque pixels");
  const [contentColor, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  assert.ok(count / sampled >= 0.35, `editor interior has no dominant opaque fill color: ${count}/${sampled} pixels`);
  const parse = (name, token) => {
    assert.ok(typeof token === "string" && /^#[0-9a-f]{6}$/iu.test(token), `theme ${name} is not an RGB hex token`);
    return [1, 3, 5].map((index) => Number.parseInt(token.slice(index, index + 2), 16));
  };
  const cardColor = parse("card", theme.card);
  const planeColor = parse("background", theme.bg);
  const borderColors = [theme.edge, theme.rule, theme.focus].filter((value) => value !== undefined).map((value, index) =>
    parse(`border ${index}`, value));
  assert.ok(borderColors.length > 0, "theme has no declared border or focus color");
  const rgb = contentColor.split(",").map(Number);
  const conflicts = [cardColor, planeColor, ...borderColors].some((color) =>
    color.every((channel, index) => Math.abs(channel - rgb[index]) <= 4));
  assert.equal(conflicts, false, `editor fill color ${JSON.stringify(rgb)} conflicts with core card geometry colors`);
  return { contentColor: rgb, cardColor, planeColor, borderColors, cornerRadiusPt,
    sampleCount: sampled, dominantCount: count };
}

async function editorDescriptor(s, diagnostic) {
  const cases = await viewContentCases(s, diagnostic);
  return editorViewDescriptor(cases.get("editor"));
}

/** Builds the editor measurement callbacks from the declared fixture content. */
export function editorViewDescriptor(content) {
  assert.ok(content?.params?.path, "the editor measurement case has no document path");
  const editorPath = content.params.path;
  const expectedLength = "SOKSAK EDITOR CONTENT".length + 1;
  return {
    plugin: "editor",
    params: content.params,
    expectedContent: "SOKSAK EDITOR CONTENT",
    language: "en-US",
    readinessStatus: "editor.document",
    readiness: async (session, surface) => {
      await session.until("editor.document", (value) => value.path === editorPath && value.length === expectedLength,
        `editor ${surface} did not load its measurement document`, { surface });
      const rect = await session.rect("editor.content", undefined, surface);
      assert.ok(rect.width > 0 && rect.height > 0, `editor ${surface} has no visible content region`);
      const state = await session.run("editor.diagnostics.content-trace", { action: "read" }, surface);
      assert.equal(state.historyEntries, 1, `editor ${surface} history does not contain only its initial document`);
      return state;
    },
    readDocument: async (session, surface) => {
      const history = await session.run("editor.diagnostics.content-trace", { action: "read" }, surface);
      assert.equal(history.regionHistoryEntries, 0, `editor ${surface} unexpectedly attached a native document region`);
      return history;
    },
    startContentTrace: async (session, surface) => {
      const result = await session.run("editor.diagnostics.content-trace", { action: "start" }, surface);
      assert.equal(result.enabled, true, `editor ${surface} content-frame observer did not start`);
      return result;
    },
    stopContentTrace: async (session, surface) => {
      const result = await session.run("editor.diagnostics.content-trace", { action: "stop" }, surface);
      assert.equal(result.enabled, false, `editor ${surface} content-frame observer did not stop`);
      return result;
    },
  };
}

/** Starts the shared process/pixel lifecycle observations and measures the hidden editor fixture. */
export async function prepareEditorMeasurements(t, s) {
  const descriptor = await editorDescriptor(s, (message) => t.diagnostic(message));
  const start = await collectViewStartAndMemory(t, s, descriptor, { viewCount: 3 });
  const { values } = await s.get("core.settings");
  const mode = values.mode;
  const themeName = values.theme;
  const theme = (await s.get("core.themes")).find((item) => item.name === themeName)?.[mode];
  assert.ok(theme, `active core theme ${themeName}/${mode} is unavailable`);
  const cornerRadiusPt = effectiveCardCornerRadiusPt(values);
  return { descriptor, start, theme, cornerRadiusPt };
}

/** Adds the three reclaim observations and editor-specific metrics to shared lifecycle and motion evidence. */
export async function finishEditorMeasurements(t, s, prepared, motion) {
  assert.ok(prepared?.descriptor && prepared?.start, "editor measurement preparation is required");
  assert.ok(motion?.layoutDisplay && motion?.drag, "editor layout and drag recording evidence is required");
  const evidence = { events: [...prepared.start.events, ...motion.evidence.events],
    recordings: [...prepared.start.recordings, ...motion.evidence.recordings] };
  const reclaim = await collectViewReclaimMeasurements(t, s, prepared.descriptor, prepared.start.opened, evidence);
  const hiddenMemory = await collectHiddenEditorFootprint(s, prepared.start.total.oneViewProcesses);
  return {
    plugin: "editor",
    host: s.app.name,
    total: prepared.start.total,
    reclaim,
    warmDisplay: prepared.start.warmDisplay,
    newProcess: { processStarts: prepared.start.processStarts, firstDisplays: prepared.start.firstDisplays },
    editorFootprint: hiddenMemory.editorFootprint,
    layoutDisplay: motion.layoutDisplay,
    drag: motion.drag,
    _evidence: { ...evidence, pixelPalette: motion.evidence.pixelPalette, editorFootprint: hiddenMemory.evidence },
  };
}
