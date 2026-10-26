import assert from "node:assert/strict";

import { drag } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { firstContentFrame } from "../../view-first-content.mjs";
import { declaredSlotInsets, findFirstChangedSlotFrame, measureViewFrameGeometry } from "../../view-frame-geometry.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, mapViewContentFramesToCapture, monotonicTimeMs, viewFootprints,
  requireViewContentFrameCoverage, withViewContentTrace } from "../../view-metrics-collection.mjs";
import { viewContentCases } from "../../view-content.mjs";

/** Measures the complete OS process group attached to selected editor view surfaces. */
export async function collectEditorProcessFootprint(s, surfaces, measureFootprint) {
  const processes = await viewFootprints(await s.get("host.window"), surfaces, measureFootprint);
  return { pids: processes.map(({ pid }) => pid), processes };
}

/** Converts before/after OS footprint samples and the diagnostic fixture reply into measured editor bytes. */
export function editorFootprintEvidence(beforeProcesses, afterProcesses, fixture, { documentLength, lines }) {
  assertProcessRows(beforeProcesses, "before");
  assertProcessRows(afterProcesses, "after");
  const before = new Map(beforeProcesses.map((row) => [row.pid, row.footprintBytes]));
  const after = new Map(afterProcesses.map((row) => [row.pid, row.footprintBytes]));
  assert.deepEqual([...after.keys()].sort((a, b) => a - b), [...before.keys()].sort((a, b) => a - b),
    "hidden editor fixture footprint must use the same view process identities before and after mount");
  assert.deepEqual(Object.keys(fixture ?? {}).sort(), ["documentLength", "historyEntries", "lines", "mounted", "regionHistoryEntries"],
    "hidden editor fixture returned unexpected measurement fields");
  assert.equal(fixture.mounted, true, "hidden editor fixture is not mounted");
  assert.equal(fixture.documentLength, documentLength, "hidden editor fixture copied an unexpected document length");
  assert.equal(fixture.lines, lines, "hidden editor fixture reports an unexpected line count");
  assert.equal(fixture.historyEntries, 1, "hidden editor fixture history contains entries beyond its initial document");
  assert.equal(fixture.regionHistoryEntries, 0, "hidden editor fixture unexpectedly attached a native document region");
  const viewBytes = [...before.values()].reduce((sum, value) => sum + value, 0);
  const afterBytes = [...after.values()].reduce((sum, value) => sum + value, 0);
  assert.ok(Number.isSafeInteger(viewBytes) && Number.isSafeInteger(afterBytes), "editor footprint sum is not a safe integer");
  assert.ok(afterBytes >= viewBytes, `editor process footprint decreased during hidden fixture mount: ${viewBytes} -> ${afterBytes}`);
  return { viewBytes, hiddenDomBytes: afterBytes - viewBytes };
}

function assertProcessRows(rows, phase) {
  assert.ok(Array.isArray(rows) && rows.length > 0, `hidden editor fixture requires nonempty ${phase} process samples`);
  assert.equal(new Set(rows.map((row) => row?.pid)).size, rows.length, `hidden editor fixture ${phase} PIDs must be unique`);
  for (const row of rows) {
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0, `hidden editor fixture ${phase} PID is invalid`);
    assert.ok(Number.isSafeInteger(row.footprintBytes) && row.footprintBytes > 0,
      `hidden editor fixture ${phase} footprint for ${row.pid} is invalid`);
  }
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

function editorFrameGeometry(frame, palette) {
  return measureViewFrameGeometry(frame, palette);
}

function editorDocumentRow(host, surface) {
  const row = host.documents.find((item) => item.surface === surface && item.document === "");
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `editor surface ${surface} has no visible view document frame`);
  return row;
}

async function editorLayoutObservation(t, s, descriptor, surface, card, theme) {
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
  const { beforeChangeTimeMs, result, captured, paletteRect } = traced.action;
  const host = await s.get("host.window");
  const root = editorDocumentRow(host, surface);
  const palette = editorGeometryPalette(captured[0], paletteRect, theme);
  const source = traced.contentFrames.find((frame) => frame.timeMs >= beforeChangeTimeMs
    && frame.width === root.frame.width && frame.height === root.frame.height);
  assert.ok(source, `editor content trace has no frame at declared size ${root.frame.width}x${root.frame.height}`);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const region = await s.rect("editor.content", undefined, surface);
  const slotInsetsPt = editorContentSlotInsets(grid, surfaces, card, surface, region);
  const measured = captured.map((frame) => editorFrameGeometry(frame, palette));
  const transition = findFirstChangedSlotFrame(measured, { beforeChangeTimeMs, slotInsetsPt });
  const candidates = transition.slotMatchFrameIndices.filter((index) => captured[index].time >= source.timeMs);
  assert.ok(candidates.length > 0, "editor layout has no declared-slot pixel match after its source resize event");
  const localProof = await firstContentFrame({ captured: candidates.map((index) => captured[index]),
    rect: { x: root.frame.x, y: root.frame.y, w: root.frame.width, h: root.frame.height },
    expected: descriptor.expectedContent, language: descriptor.language, directory: result.frames });
  const frameIndex = candidates[localProof.frameIndex];
  const geometry = measured[frameIndex];
  return {
    changeFrame: { frameIndex: transition.changeFrameIndex, frameCount: captured.length,
      timeMs: captured[transition.changeFrameIndex].time },
    contentFrame: { frameIndex, frameCount: captured.length, timeMs: captured[frameIndex].time,
      width: source.width, height: source.height, nativeWidth: root.frame.width, nativeHeight: root.frame.height,
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
  const slotInsetsPt = editorContentSlotInsets(grid, surfaces, card, surface,
    await s.rect("editor.content", undefined, surface));
  const rootSlotInsetsPt = editorSlotInsets(grid, surfaces, card, surface);
  const geometryFrames = [];
  const geometryByFrame = new Map();
  for (let frameIndex = firstGestureFrameIndex; frameIndex <= gestureEndedFrameIndex; frameIndex++) {
    const measured = editorFrameGeometry(captured[frameIndex], palette);
    geometryByFrame.set(frameIndex, measured);
    geometryFrames.push({ frameIndex, timeMs: captured[frameIndex].time,
      cardRectPt: measured.cardRectPt, nativeRectPt: measured.nativeRectPt, slotInsetsPt });
  }
  const contentFrames = [];
  const mapped = requireViewContentFrameCoverage(mapViewContentFramesToCapture(traced.contentFrames, captured), {
    gestureStartedAtMs: run.ticks[0], gestureEndedAtMs: run.ticks.at(-1),
  });
  for (const source of mapped) {
    if (source.frameIndex === null) continue;
    const geometry = geometryByFrame.get(source.frameIndex)
      ?? editorFrameGeometry(captured[source.frameIndex], palette);
    const nativeWidth = geometry.cardRectPt.right - geometry.cardRectPt.left
      - rootSlotInsetsPt.left - rootSlotInsetsPt.right;
    const nativeHeight = geometry.cardRectPt.bottom - geometry.cardRectPt.top
      - rootSlotInsetsPt.top - rootSlotInsetsPt.bottom;
    assert.ok(nativeWidth > 0 && nativeHeight > 0, "editor root declared slot has no positive size");
    contentFrames.push({ sourceSequence: source.sourceSequence, frameIndex: source.frameIndex,
      timeMs: source.timeMs, width: source.width, height: source.height,
      nativeWidth, nativeHeight, source });
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

/** Measures layout presentation and a full card drag using actual editor capture pixels. */
export async function collectEditorMotionMeasurements(t, s, prepared) {
  const surface = prepared.start.warmDisplay.surface;
  const layoutDisplay = await editorLayoutObservation(t, s, prepared.descriptor, surface,
    prepared.start.card, prepared.theme);
  const drag = await editorDragObservation(t, s, prepared.descriptor, surface,
    prepared.start.card, layoutDisplay.pixelPalette);
  return { layoutDisplay: [layoutDisplay], drag,
    evidence: { events: [...layoutDisplay.events, ...drag.events],
      recordings: [{ directory: layoutDisplay.captureDirectory }, { directory: drag.captureDirectory }],
      pixelPalette: layoutDisplay.pixelPalette } };
}

/** Derives an opaque editor-fill palette from the interior, rejecting core geometry colors. */
export function editorGeometryPalette(frame, rect, theme) {
  assert.ok(frame && frame.data instanceof Uint8Array && frame.data.length === frame.stride * frame.height,
    "editor palette requires a complete decoded frame");
  assert.ok(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0, "editor palette requires a visible document rectangle");
  assert.ok(theme && typeof theme === "object", "editor palette requires the active core theme");
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
  const borderColors = [theme.edge, theme.focus].filter((value) => value !== undefined).map((value, index) =>
    parse(`border ${index}`, value));
  assert.ok(borderColors.length > 0, "theme has no declared border or focus color");
  const rgb = contentColor.split(",").map(Number);
  const conflicts = [cardColor, planeColor, ...borderColors].some((color) =>
    color.every((channel, index) => Math.abs(channel - rgb[index]) <= 4));
  assert.equal(conflicts, false, `editor fill color ${JSON.stringify(rgb)} conflicts with core card geometry colors`);
  return { contentColor: rgb, cardColor, planeColor, borderColors, sampleCount: sampled, dominantCount: count };
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
  const surface = start.opened.at(-1).surface;
  let mounted = false;
  let editorFootprint;
  try {
    const beforeProcesses = await viewFootprints(await s.get("host.window"), [surface]);
    const mount = await s.run("editor.memory.hidden", { action: "mount" }, surface);
    assert.deepEqual(Object.keys(mount).sort(), ["documentLength", "historyEntries", "lines", "mounted", "regionHistoryEntries"]);
    assert.equal(mount.mounted, true, "hidden editor fixture did not mount");
    assert.equal(mount.documentLength, "SOKSAK EDITOR CONTENT".length + 1,
      "hidden editor fixture did not copy the full editor document");
    assert.equal(mount.lines, 2, "hidden editor fixture line count differs from the copied document");
    assert.equal(mount.historyEntries, 1, "hidden editor fixture history differs from its initial document");
    mounted = true;
    const read = await s.run("editor.memory.hidden", { action: "read" }, surface);
    for (const field of ["mounted", "documentLength", "lines", "historyEntries", "regionHistoryEntries"]) {
      assert.equal(read[field], mount[field], `hidden editor fixture ${field} changed before the sample`);
    }
    const afterProcesses = await viewFootprints(await s.get("host.window"), [surface]);
    editorFootprint = editorFootprintEvidence(beforeProcesses, afterProcesses, mount,
      { documentLength: "SOKSAK EDITOR CONTENT".length + 1, lines: 2 });
  } finally {
    if (mounted) {
      const removed = await s.run("editor.memory.hidden", { action: "remove" }, surface);
      assert.equal(removed.mounted, false, "hidden editor fixture remained mounted after remove");
    }
  }

  const mode = (await s.get("core.settings")).values.mode;
  const themeName = (await s.get("core.settings")).values.theme;
  const theme = (await s.get("core.themes")).find((item) => item.name === themeName)?.[mode];
  assert.ok(theme, `active core theme ${themeName}/${mode} is unavailable`);
  return { descriptor, start, editorFootprint, theme };
}

/** Adds the three reclaim observations and editor-specific metrics to shared lifecycle and motion evidence. */
export async function finishEditorMeasurements(t, s, prepared, motion) {
  assert.ok(prepared?.descriptor && prepared?.start, "editor measurement preparation is required");
  assert.ok(motion?.layoutDisplay && motion?.drag, "editor layout and drag recording evidence is required");
  const evidence = { events: [...prepared.start.events, ...motion.evidence.events],
    recordings: [...prepared.start.recordings, ...motion.evidence.recordings] };
  const reclaim = await collectViewReclaimMeasurements(t, s, prepared.descriptor, prepared.start.opened, evidence);
  return {
    plugin: "editor",
    host: s.app.name,
    total: prepared.start.total,
    reclaim,
    warmDisplay: prepared.start.warmDisplay,
    newProcess: { processStarts: prepared.start.processStarts, firstDisplays: prepared.start.firstDisplays },
    editorFootprint: prepared.editorFootprint,
    layoutDisplay: motion.layoutDisplay,
    drag: motion.drag,
    _evidence: { ...evidence, pixelPalette: motion.evidence.pixelPalette },
  };
}
