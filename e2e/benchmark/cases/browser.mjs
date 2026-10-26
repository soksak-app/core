import assert from "node:assert/strict";
import { createServer } from "node:http";

import { drag } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { firstContentFrame } from "../../view-first-content.mjs";
import { declaredSlotInsets, findFirstChangedSlotFrame, measureViewFrameGeometry }
  from "../../view-frame-geometry.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, monotonicTimeMs,
  mapViewContentFramesToCapture, requireViewContentFrameCoverage, waitForViewReadiness, withViewContentTrace }
  from "../../view-metrics-collection.mjs";

/** Browser-specific inputs for the shared view lifecycle measurement collector. */
export const browserViewDescriptor = Object.freeze({
  plugin: "browser",
  params: undefined,
  expectedContent: "주소를 입력하세요",
  language: "ko-KR",
  readinessStatus: "browser.location",
  readiness: async (s, surface) => {
    const location = await s.until("browser.location", (value) => value.url === "" && !value.loading && value.error === null,
      `browser view ${surface} did not reach its initial empty state`, { surface });
    assert.equal(location.url, "", `browser view ${surface} navigated away from its initial empty state`);
    assert.equal(location.canGoBack, false, `browser view ${surface} has prior session history`);
    assert.equal(location.canGoForward, false, `browser view ${surface} has forward session history`);
    const rect = await s.rect("browser.empty", undefined, surface);
    assert.ok(rect.width > 0 && rect.height > 0, `browser view ${surface} has no visible empty-state content region`);
    const document = await s.run("browser.view.measure", { action: "read" }, surface);
    assert.equal(document?.historyEntries, 1,
      `browser view ${surface} actual browser view history is not its initial entry`);
    return { historyEntries: document.historyEntries, regionHistoryEntries: document.regionHistoryEntries, location };
  },
  readDocument: async (s, surface) => s.run("browser.view.measure", { action: "read" }, surface),
  startContentTrace: async (s, surface) => s.run("browser.view.measure", { action: "start" }, surface),
  stopContentTrace: async (s, surface) => {
    await s.run("browser.view.measure", { action: "stop" }, surface);
    return s.run("browser.view.measure", { action: "read" }, surface);
  },
});

const GEOMETRY = Object.freeze({ contentColor: [30, 30, 30], cardColor: [25, 27, 36],
  planeColor: [16, 17, 23], borderColors: [[43, 46, 61], [255, 179, 107]], colorTolerance: 3 });
const CONTENT = "SOKSAK BROWSER CONTENT";
const GEOMETRY_LIMIT_PT = 2;

/** Compares captured content with the slot declared by the card and browser document DOM. */
export function assertBrowserFrameMatchesSlot(geometry, slotInsetsPt) {
  assert.ok(geometry?.cardRectPt && geometry?.nativeRectPt,
    "browser frame geometry requires measured card and content rectangles");
  assert.ok(slotInsetsPt && [slotInsetsPt.left, slotInsetsPt.top, slotInsetsPt.right, slotInsetsPt.bottom]
    .every((value) => Number.isFinite(value) && value >= 0), "browser frame geometry requires declared slot insets");
  const expected = {
    left: geometry.cardRectPt.left + slotInsetsPt.left,
    top: geometry.cardRectPt.top + slotInsetsPt.top,
    right: geometry.cardRectPt.right - slotInsetsPt.right,
    bottom: geometry.cardRectPt.bottom - slotInsetsPt.bottom,
  };
  assert.ok(expected.right > expected.left && expected.bottom > expected.top,
    `browser declared slot has no positive area: ${JSON.stringify(expected)}`);
  const errorPt = Math.max(...["left", "top", "right", "bottom"]
    .map((edge) => Math.abs(expected[edge] - geometry.nativeRectPt[edge])));
  assert.ok(errorPt <= GEOMETRY_LIMIT_PT,
    `browser content differs from its declared card slot by ${errorPt} pt (limit ${GEOMETRY_LIMIT_PT} pt)`);
  return errorPt;
}

/** Serves a distinctive opaque browser document with live content pixels for layout and drag recordings. */
async function serveContentPage(s) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><meta charset="utf-8"><title>${CONTENT}</title>
      <style>html,body,#surface{width:100%;height:100%;margin:0}#surface{box-sizing:border-box;overflow:hidden;background:rgb(30,30,30);color:white;font:32px sans-serif}</style>
      <div id="surface">${CONTENT}</div>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  s.cleanup(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}/content`;
}

async function stopRecording(recording, s, after) {
  const result = await recording.stop({ after });
  assert.equal(result.limited, false, "browser view measurement recording reached its bounded frame limit");
  const paths = frames(result.frames);
  assert.equal(paths.length, result.count, "browser view measurement recording omitted finalized frames");
  assert.ok(paths.length > 0, "browser view measurement recording contains no frames");
  return { result, paths, decoded: paths.map(readFrame) };
}

function documentRow(host, surface, document) {
  const row = host.documents.find((item) => item.surface === surface && item.document === document);
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `browser surface ${surface} has no visible ${document || "root"} document frame`);
  return row;
}

async function layoutObservation(t, s, descriptor, surface, card, expectedWidth, url) {
  await s.run("browser.navigate", { url }, surface);
  await s.until("browser.location", (value) => value.url === url && !value.loading
    && value.error === null && value.title === CONTENT, "the controlled browser content did not load", { surface });
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () => {
    const recording = await s.record();
    const grid = await s.get("core.grid");
    const pane = grid.cards.find((item) => item.id === card);
    assert.ok(pane && Number.isFinite(pane.w), `browser measurement card ${card} has no current width`);
    const targetWidth = pane.w + expectedWidth;
    const beforeChangeTimeMs = (await monotonicTimeMs(s)).timeMs;
    await s.run("core.grid.size", { card, axis: "x", size: targetWidth });
    const { displayed } = await s.presented();
    const capture = await stopRecording(recording, s, displayed);
    return { ...capture, displayed, beforeChangeTimeMs };
  });
  const { decoded, result, beforeChangeTimeMs } = traced.action;
  const host = await s.get("host.window");
  const root = documentRow(host, surface, "");
  const page = documentRow(host, surface, "page");
  const content = traced.contentFrames.find((frame) => frame.width === root.frame.width
    && frame.height === root.frame.height && frame.timeMs >= beforeChangeTimeMs);
  assert.ok(content, `browser source has no content frame at its new native size ${root.frame.width}x${root.frame.height}`);
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const region = await s.rect("browser.document", undefined, surface);
  const targetRect = { x: page.frame.x, y: page.frame.y,
    width: page.frame.width, height: page.frame.height };
  const slotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface,
    regionRect: { x: region.x, y: region.y, w: region.width, h: region.height } });
  const measured = decoded.map((frame) => measureViewFrameGeometry(frame, { ...GEOMETRY, targetRect }));
  const transition = findFirstChangedSlotFrame(measured, { beforeChangeTimeMs, slotInsetsPt });
  const candidates = transition.slotMatchFrameIndices.filter((index) => decoded[index].time >= content.timeMs);
  assert.ok(candidates.length > 0, "browser layout has no declared-slot pixel match after its source resize event");
  const localProof = await firstContentFrame({ captured: candidates.map((index) => decoded[index]),
    rect: { x: page.frame.x, y: page.frame.y, w: page.frame.width, h: page.frame.height },
    expected: CONTENT, language: "en-US", directory: result.frames });
  const frameIndex = candidates[localProof.frameIndex];
  const proof = { ...localProof.proof, frameIndex, frameCount: decoded.length };
  const initialGeometry = measured[frameIndex];
  const initialGeometryErrorPt = assertBrowserFrameMatchesSlot(initialGeometry, slotInsetsPt);
  return {
    changeFrame: { frameIndex: transition.changeFrameIndex, frameCount: decoded.length,
      timeMs: decoded[transition.changeFrameIndex].time },
    contentFrame: { frameIndex, frameCount: decoded.length, timeMs: decoded[frameIndex].time,
      width: content.width, height: content.height, nativeWidth: root.frame.width, nativeHeight: root.frame.height, proof },
    sourceFrame: content,
    slotInsetsPt,
    initialGeometry: { frameIndex, timeMs: decoded[frameIndex].time, cardRectPt: initialGeometry.cardRectPt,
      nativeRectPt: initialGeometry.nativeRectPt, slotInsetsPt, errorPt: initialGeometryErrorPt },
    events: traced.events,
    captureDirectory: result.frames,
  };
}

async function dragObservation(t, s, descriptor, surface, card, slotInsetsPt) {
  const traced = await withViewContentTrace(t, s, descriptor, surface, async () =>
    drag(t, s, { axis: "x", line: 1, dx: 80, dy: 0, ms: 500, times: 1 }, { capture: true }));
  const run = traced.action;
  const files = frames(run.frames);
  assert.equal(files.length, run.count, "browser drag recording omitted finalized frame files");
  const captured = files.map(readFrame);
  assert.ok(captured.length > 2, "browser drag recording contains too few frames");
  const firstGestureFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks[0]);
  const gestureEndedFrameIndex = captured.findIndex((frame) => frame.time >= run.ticks.at(-1));
  assert.ok(firstGestureFrameIndex >= 0 && gestureEndedFrameIndex >= firstGestureFrameIndex,
    "browser drag capture does not cover the complete requested gesture");
  const grid = await s.get("core.grid");
  const surfaces = await s.get("core.surfaces");
  const page = documentRow(await s.get("host.window"), surface, "page");
  const targetRect = { x: page.frame.x, y: page.frame.y,
    width: page.frame.width, height: page.frame.height };
  const rootSlotInsetsPt = declaredSlotInsets({ grid, surfaces, card, surface });
  const geometryFrames = [];
  const geometryByFrame = new Map();
  for (let frameIndex = firstGestureFrameIndex; frameIndex <= gestureEndedFrameIndex; frameIndex++) {
    const measured = measureViewFrameGeometry(captured[frameIndex], { ...GEOMETRY, targetRect });
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
      ?? measureViewFrameGeometry(captured[source.frameIndex], { ...GEOMETRY, targetRect });
    const nativeWidth = geometry.cardRectPt.right - geometry.cardRectPt.left
      - rootSlotInsetsPt.left - rootSlotInsetsPt.right;
    const nativeHeight = geometry.cardRectPt.bottom - geometry.cardRectPt.top
      - rootSlotInsetsPt.top - rootSlotInsetsPt.bottom;
    assert.ok(nativeWidth > 0 && nativeHeight > 0, "browser root declared slot has no positive size");
    contentFrames.push({ sourceSequence: source.sourceSequence, frameIndex: source.frameIndex,
      timeMs: source.timeMs, width: source.width, height: source.height,
      nativeWidth, nativeHeight, source });
  }
  const recordedFrameCount = captured.length;
  return {
    recordedFrameCount,
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

/** Collects the browser view lifecycle, actual source-frame, and same-capture pixel geometry evidence. */
export async function collectBrowserViewMeasurements(t, s, descriptor) {
  const start = await collectViewStartAndMemory(t, s, descriptor);
  const url = await serveContentPage(s);
  const split = await s.run("core.card.split", { card: start.card, side: "right", plugin: descriptor.plugin });
  const surface = split.tab;
  const card = split.card;
  s.cleanup(async () => {
    const grid = await s.get("core.grid");
    if (!grid.cards.some((item) => item.id === card)) return;
    const result = await s.run("core.card.close", { card });
    assert.equal(result?.closed, true, `browser measurement card ${card} did not close during cleanup`);
    await s.until("core.grid", (value) => !value.cards.some((item) => item.id === card),
      `browser measurement card ${card} remained during cleanup`);
  });
  const readinessEvidence = await waitForViewReadiness(s, surface, descriptor);
  assert.equal(readinessEvidence?.historyEntries, 1, "browser drag fixture did not begin at initial history");
  const layout = await layoutObservation(t, s, descriptor, surface, card, 80, url);
  const drag = await dragObservation(t, s, descriptor, surface, card, layout.slotInsetsPt);
  const scratch = { surface, readinessEvidence };
  const close = await s.run("core.tab.close", { tab: surface });
  assert.equal(close?.closed, true, `browser measurement view ${surface} did not close after capture`);
  await s.until("core.surfaces", (items) => !items.some((item) => item.surface === surface),
    `browser measurement view ${surface} remained after capture`);
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
    _evidence: { ...evidence, scratch, initialGeometry: layout.initialGeometry },
  };
}
