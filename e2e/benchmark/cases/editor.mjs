import assert from "node:assert/strict";

import { declaredSlotInsets, effectiveCardCornerRadiusPt } from "../../view-frame-geometry.mjs";
import { collectViewReclaimMeasurements, collectViewStartAndMemory, TAB_PLACEMENT, viewCardWithDifferentPluginTab,
  viewFootprints } from "../../view-metrics-collection.mjs";
import { viewContentCases } from "../../view-content.mjs";
import { viewProcessGroup } from "../../view-process-footprint.mjs";
import { activeCoreTheme, dragTailGeometryFrame, markerDragObservation, markerLayoutObservation, paletteWithMarkerColor,
  sourceContentFrame, themeGeometryPalette } from "./marker-view.mjs";

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

/** Validates and applies the RGB paint color declared by the successful Editor trace start. */
export function editorPaletteWithMarkerColor(palette, markerColor) {
  return paletteWithMarkerColor(palette, markerColor, "editor");
}

/** Records same-frame measured Editor content geometry for one post-gesture capture. */
export function editorDragTailGeometryFrame(frameIndex, measured, slotInsetsPt) {
  return dragTailGeometryFrame(frameIndex, measured, slotInsetsPt, "editor");
}

/** Preserves source dimensions and the capture frame that proves its display. */
export function editorSourceContentFrame(source, captureTimeMs, displayCapture = null) {
  return sourceContentFrame(source, captureTimeMs, displayCapture, "editor");
}

/** The drag observation (viii) of the Editor view: the first vertical boundary moves 80 pt right and back once. */
async function editorDragObservation(t, s, descriptor, surface, card, palette) {
  return markerDragObservation(t, s, descriptor, surface, card, palette,
    { owner: "editor", plan: { axis: "x", line: 1, dx: 80, dy: 0, ms: 500, times: 1 } });
}

/** Measures layout presentation and a full card drag using actual editor capture pixels. */
export async function collectEditorMotionMeasurements(t, s, prepared) {
  const surface = prepared.start.warmDisplay.surface;
  const layoutDisplay = await markerLayoutObservation(t, s, prepared.descriptor, surface, prepared.start.card,
    { owner: "editor", theme: prepared.theme, cornerRadiusPt: prepared.cornerRadiusPt, axis: "x" });
  const drag = await editorDragObservation(t, s, prepared.descriptor, surface,
    prepared.start.card, layoutDisplay.pixelPalette);
  return { layoutDisplay: [layoutDisplay], drag,
    evidence: { events: [...layoutDisplay.events, ...drag.events],
      recordings: [{ directory: layoutDisplay.captureDirectory }, { directory: drag.captureDirectory }],
      pixelPalette: layoutDisplay.pixelPalette } };
}

/** Uses the exact opaque CSS paint color set by the Editor content-frame diagnostic. */
export function editorGeometryPalette(frame, rect, theme, cornerRadiusPt, markerColor) {
  return themeGeometryPalette(frame, rect, theme, cornerRadiusPt, markerColor, "editor");
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
    placement: TAB_PLACEMENT,
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
  const theme = await activeCoreTheme(s);
  const cornerRadiusPt = effectiveCardCornerRadiusPt((await s.get("core.settings")).values);
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
