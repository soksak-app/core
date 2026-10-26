import assert from "node:assert/strict";

import { drag } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { firstContentFrame } from "../../view-first-content.mjs";
import { declaredSlotInsets, findFirstChangedSlotFrame, measureViewFrameGeometry } from "../../view-frame-geometry.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, mapViewContentFramesToCapture,
  monotonicTimeMs, requireViewContentFrameCoverage, withViewContentTrace }
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

/** Derives the HWP document-root fill from recorded opaque pixels inside its actual studio child rectangle. */
export function hwpGeometryPalette(frame, rect, theme) {
  assert.ok(frame?.data instanceof Uint8Array && frame.data.length === frame.stride * frame.height,
    "HWP geometry palette requires a complete decoded frame");
  assert.ok(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0, "HWP geometry palette requires a visible studio rectangle");
  assert.ok(theme && typeof theme === "object", "HWP geometry palette requires the active core theme");
  const ratio = frame.scale * frame.contentScale;
  assert.ok(Number.isFinite(ratio) && ratio > 0 && frame.content
    && Number.isFinite(frame.content.x) && Number.isFinite(frame.content.y), "HWP geometry palette has invalid capture scale");
  const left = Math.floor(frame.content.x * frame.scale + (rect.x + rect.width * 0.2) * ratio);
  const top = Math.floor(frame.content.y * frame.scale + (rect.y + rect.height * 0.2) * ratio);
  const right = Math.ceil(frame.content.x * frame.scale + (rect.x + rect.width * 0.8) * ratio);
  const bottom = Math.ceil(frame.content.y * frame.scale + (rect.y + rect.height * 0.8) * ratio);
  assert.ok(left >= 0 && top >= 0 && right <= frame.width && bottom <= frame.height && right > left && bottom > top,
    "HWP studio palette sample lies outside the decoded frame");

  const colors = new Map();
  let sampled = 0;
  for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
    const offset = y * frame.stride + x * 4;
    if (frame.data[offset + 3] !== 255) continue;
    const color = [frame.data[offset + 2], frame.data[offset + 1], frame.data[offset]];
    const key = color.join(",");
    colors.set(key, (colors.get(key) ?? 0) + 1);
    sampled++;
  }
  assert.ok(sampled > 0, "HWP studio palette sample contains no opaque pixels");
  const [contentKey, dominantCount] = [...colors.entries()].sort((a, b) => b[1] - a[1])[0];
  assert.ok(dominantCount / sampled >= 0.35,
    `HWP studio rectangle has no dominant opaque fill: ${dominantCount}/${sampled} pixels`);
  const parse = (name, token) => {
    assert.ok(typeof token === "string" && /^#[0-9a-f]{6}$/iu.test(token), `core theme ${name} is not an RGB hex token`);
    return [1, 3, 5].map((index) => Number.parseInt(token.slice(index, index + 2), 16));
  };
  const contentColor = contentKey.split(",").map(Number);
  const cardColor = parse("card", theme.card);
  const planeColor = parse("background", theme.bg);
  const borderColors = [theme.edge, theme.focus].filter((value) => value !== undefined)
    .map((value, index) => parse(`border ${index}`, value));
  assert.ok(borderColors.length > 0, "core theme has no declared card border or focus color");
  assert.equal([cardColor, planeColor, ...borderColors].some((color) =>
    color.every((channel, index) => Math.abs(channel - contentColor[index]) <= 4)), false,
  `HWP studio fill ${JSON.stringify(contentColor)} conflicts with the active card, plane, or border colors`);
  return { contentColor, cardColor, planeColor, borderColors, sampleCount: sampled, dominantCount };
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
      const value = await session.run("hwp.diagnostics.frames.start", {}, surface);
      assert.equal(value.enabled, true, `HWP view ${surface} content-frame observer did not start`);
      return value;
    },
    stopContentTrace: async (session, surface) => {
      const value = await session.run("hwp.diagnostics.frames.stop", {}, surface);
      assert.equal(value.enabled, false, `HWP view ${surface} content-frame observer did not stop`);
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

function geometryPalette(frame, studio, theme) {
  return hwpGeometryPalette(frame, studio.frame, theme);
}

async function layoutObservation(t, s, descriptor, surface, card, theme) {
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () => {
    const recording = await s.record();
    const grid = await s.get("core.grid");
    const pane = grid.cards.find((item) => item.id === card);
    assert.ok(pane && Number.isFinite(pane.w), `HWP measurement card ${card} has no current width`);
    const studioBefore = documentRow(await s.get("host.window"), surface, "studio");
    const beforeChangeTimeMs = (await monotonicTimeMs(s)).timeMs;
    await s.run("core.grid.size", { card, axis: "x", size: pane.w + 80 });
    const { displayed } = await s.presented();
    const result = await recording.stop({ after: displayed });
    return { displayed, beforeChangeTimeMs, result, captured: captureFrames(result, "layout"),
      paletteRect: studioBefore.frame };
  });
  const { beforeChangeTimeMs, captured, result, paletteRect } = traced.action;
  const host = await s.get("host.window");
  const root = documentRow(host, surface, "");
  const studio = documentRow(host, surface, "studio");
  const source = traced.contentFrames.find((frame) => frame.timeMs >= beforeChangeTimeMs
    && frame.width === root.frame.width && frame.height === root.frame.height);
  assert.ok(source, `HWP root trace has no post-layout frame at ${root.frame.width}x${root.frame.height}`);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const region = await s.rect("hwp.studio", undefined, surface);
  const slotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface,
    regionRect: { x: region.x, y: region.y, w: region.width, h: region.height } });
  const themeGeometry = geometryPalette(captured[0], { frame: paletteRect }, theme);
  const measured = captured.map((frame) => measureViewFrameGeometry(frame, themeGeometry));
  const transition = findFirstChangedSlotFrame(measured, { beforeChangeTimeMs, slotInsetsPt });
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
      width: source.width, height: source.height,
      nativeWidth: geometry.nativeRectPt.right - geometry.nativeRectPt.left,
      nativeHeight: geometry.nativeRectPt.bottom - geometry.nativeRectPt.top, proof },
    sourceFrame: source,
    slotInsetsPt,
    initialGeometry: { frameIndex, timeMs: captured[frameIndex].time, cardRectPt: geometry.cardRectPt,
      nativeRectPt: geometry.nativeRectPt, slotInsetsPt, errorPt: initialGeometryErrorPt },
    pixelPalette: themeGeometry,
    events: traced.events,
    captureDirectory: result.frames,
  };
}

async function dragObservation(t, s, descriptor, surface, card, theme) {
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const rootSlotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface });
  const region = await s.rect("hwp.studio", undefined, surface);
  const slotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface,
    regionRect: { x: region.x, y: region.y, w: region.width, h: region.height } });
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () =>
    drag(t, s, { axis: "x", line: 1, dx: 80, dy: 0, ms: 500, times: 1 }, { capture: true }));
  const run = traced.action;
  const captured = captureFrames(run, "drag");
  assert.ok(captured.length > 2, "HWP drag recording contains too few frames");
  const firstGestureFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks[0]);
  const gestureEndedFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks.at(-1));
  assert.ok(firstGestureFrameIndex >= 0 && gestureEndedFrameIndex >= firstGestureFrameIndex,
    "HWP drag capture does not cover the complete requested gesture");
  const host = await s.get("host.window");
  const studio = documentRow(host, surface, "studio");
  const palette = geometryPalette(captured[firstGestureFrameIndex], studio, theme);
  const geometryFrames = [];
  const geometryByFrame = new Map();
  for (let frameIndex = firstGestureFrameIndex; frameIndex <= gestureEndedFrameIndex; frameIndex++) {
    const measured = measureViewFrameGeometry(captured[frameIndex], palette);
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
      ?? measureViewFrameGeometry(captured[source.frameIndex], palette);
    const nativeWidth = geometry.cardRectPt.right - geometry.cardRectPt.left
      - rootSlotInsetsPt.left - rootSlotInsetsPt.right;
    const nativeHeight = geometry.cardRectPt.bottom - geometry.cardRectPt.top
      - rootSlotInsetsPt.top - rootSlotInsetsPt.bottom;
    assert.ok(nativeWidth > 0 && nativeHeight > 0, "HWP root declared slot has no positive size");
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

/** Collects the HWP lifecycle, source content, layout and full-gesture measurements. */
export async function collectHwpViewMeasurements(t, s) {
  const descriptor = await hwpViewDescriptor(s, (message) => t.diagnostic(message));
  const start = await collectViewStartAndMemory(t, s, descriptor, { viewCount: 3 });
  const surface = start.warmDisplay.surface;
  const settings = (await s.get("core.settings")).values;
  const theme = (await s.get("core.themes")).find((item) => item.name === settings.theme)?.[settings.mode];
  assert.ok(theme, `active core theme ${settings.theme}/${settings.mode} is unavailable`);
  const layout = await layoutObservation(t, s, descriptor, surface, start.card, theme);
  const drag = await dragObservation(t, s, descriptor, surface, start.card, theme);
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
    _evidence: { ...evidence, initialGeometry: layout.initialGeometry, pixelPalette: layout.pixelPalette },
  };
}
