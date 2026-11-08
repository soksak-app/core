// The floor page view of the view drag and resize benchmarks (docs/operations/examples.md, F502-2 and F502-25): the fixture plugin
// floorpage of e2e/fixtures/view-drag/floor-page, preinstalled with every fixture plugin, whose view page draws the measurement colour
// over its whole frame and runs no plugin code, so a drag measures the host and the web view alone. This module opens the floor page
// as the active tab of a card, measures the card and the view rectangle of a captured frame with the geometry rule of the drag
// (the measurement colour inside the card palette), and prepares and runs the captured drag of the view drag benchmark.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drag, keepCommonSettings } from "@soksak/window-check/app.mjs";
import { frameChange, frames, readFrame } from "@soksak/window-check/frame.mjs";
import { assertDragPerformance, assertHeldStatesShown, assertRoundTrips, measureDragPerformance, pointerLag, shownTimes,
  transactionCadence } from "@soksak/window-check/drag-measurement.mjs";
import { outside } from "../../outside.mjs";
import { declaredSlotInsets, effectiveCardCornerRadiusPt, measureViewFrameGeometry, VIEW_GEOMETRY_COLOR_TOLERANCE }
  from "@soksak/window-check/view-frame-geometry.mjs";

/** The floor page plugin: its id and its folder. */
export const FLOOR_PAGE = Object.freeze({
  plugin: "floorpage",
  folder: fileURLToPath(new URL("../../fixtures/view-drag/floor-page/", import.meta.url)),
});

/** The colour that the floor page draws; it stays outside the colour tolerance of the antialiased focus outline of a card. */
export const FLOOR_COLOUR = Object.freeze([0, 80, 180]);

/** The palette of the geometry rule: the floor colour as the content inside the colours of the card, the plane and the borders. */
const FLOOR_GEOMETRY = Object.freeze({ contentColor: FLOOR_COLOUR, cardColor: [25, 27, 36],
  planeColor: [16, 17, 23], borderColors: [[43, 46, 61], [34, 36, 47], [255, 179, 107]], colorTolerance: 3 });

/** The plan of the drag of the view drag benchmark: the first boundary on the x axis, 250 pt out and back over 400 ms, twice. */
export const VIEW_DRAG_PLAN = Object.freeze({ axis: "x", line: 1, dx: 250, dy: 0, ms: 400, times: 2 });

/**
 * Adds a floor page tab to the card `card` (by default the focused card of the start layout) and waits until it is the active tab
 * of that card and its view declared its composition; returns { surface, card }. The cleanup closes the tab.
 */
export async function openFloorPage(s, { card } = {}) {
  const { plugin } = FLOOR_PAGE;
  const target = card ?? (await s.get("core.grid")).cards.find((item) => item.focused)?.id;
  if (target === undefined) throw new Error("the start layout has no focused card for the floor page");
  const { tab } = await s.run("core.card.add-tab", { card: target, plugin });
  s.cleanup(() => s.run("core.tab.close", { tab }));
  await s.until("core.grid", (grid) => grid.cards.find((item) => item.id === target)?.active === tab,
    `the floor page tab ${tab} is not the active tab of card ${target}`);
  await s.until("core.surfaces", (surfaces) => surfaces.some((row) => row.surface === tab && row.status.phase === "ready"),
    `the floor page view ${tab} did not declare its composition`);
  return { surface: tab, card: target };
}

/** Persists the transaction rows of a drag before any frame analysis can fail. */
export function writeDragLayouts(directory, layouts) {
  assert.ok(Array.isArray(layouts), "drag layouts must be an array");
  const path = join(directory, "layouts.json");
  writeFileSync(path, JSON.stringify({ layouts }, null, 2) + "\n");
  return path;
}

/** Preserves the card and the view rectangles measured in one captured frame against the slot insets of the view. */
export function dragGeometryFrame(frameIndex, measured, slotInsetsPt) {
  assert.ok(Number.isSafeInteger(frameIndex) && frameIndex >= 0, "drag frame index is invalid");
  assert.ok(Number.isFinite(measured?.timeMs) && measured.timeMs >= 0, "drag frame time is invalid");
  for (const name of ["cardRectPt", "nativeRectPt"]) {
    const rect = measured?.[name];
    assert.ok(rect && ["left", "top", "right", "bottom"].every((edge) => Number.isFinite(rect[edge]))
      && rect.right >= rect.left && rect.bottom >= rect.top, `drag ${name} is invalid`);
  }
  assert.ok(slotInsetsPt && ["left", "top", "right", "bottom"].every((edge) =>
    Number.isFinite(slotInsetsPt[edge]) && slotInsetsPt[edge] >= 0), "drag slot insets are invalid");
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

/** Measures the card and the floor colour rectangle of a captured frame with the palette of the geometry rule. */
export function measureFloorLayoutFrame(frame, { cornerRadiusPt, targetRect } = {}) {
  return measureViewFrameGeometry(frame, { ...FLOOR_GEOMETRY, cornerRadiusPt, targetRect });
}

/** The visible root document of the view `surface` in host.window. */
function viewDocument(host, surface) {
  const row = host.documents.find((document) => document.surface === surface && document.document === "");
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `view ${surface} has no visible root document frame`);
  return row;
}

/** The insets of the slot of the floor page view `surface` in its card `card`, as the layout declares them. */
export async function floorSlotInsets(s, card, surface) {
  const [grid, surfaces] = await Promise.all([s.get("core.grid"), s.get("core.surfaces")]);
  return declaredSlotInsets({ grid, surfaces, card, surface });
}

/**
 * Prepares the untraced drag capture of the floor page view `surface`, the active tab of the card `card`: it requires the trace off
 * and the default policy, gives the floor page a window-right sidebar override, and reads the marks and the rectangle that the capture
 * measures. Returns { capture }: capture() runs VIEW_DRAG_PLAN with capture and returns its evidence. The drags of the view drag
 * benchmark run between the preparation and the capture under this layout; a drag goes out and back, so the card returns to the
 * prepared rectangle.
 */
export async function prepareFloorDrag(t, s, { surface, card }, configDir) {
  assert.equal(process.env.SOKSAK_PERFORMANCE_TRACE, undefined,
    "the benchmark requires performance tracing to be unset");
  const { values } = await s.get("core.settings");
  const cornerRadiusPt = effectiveCardCornerRadiusPt(values);
  assert.equal(values["diagnostics.performance"], false, "the application performance trace is enabled");
  assert.deepEqual(values["diagnostics.log"], {}, "the application is not using its default error-only log policy");
  await keepCommonSettings(s);
  await s.run("core.settings.link", { place: "window-right", plugin: FLOOR_PAGE.plugin, set: "set-install", scope: "common" });
  await s.until("core.rail", (rail) => rail.groups.length === 1, "the floor page override drew no rail");
  const grid = await s.get("core.grid");
  assert.equal(grid.cards.find((item) => item.id === card)?.active, surface,
    `the dragged view ${surface} is not the active tab of card ${card}`);
  await s.presented();
  const slotInsetsPt = await floorSlotInsets(s, card, surface);
  const host = await s.get("host.window");
  // The marks of the card head and the view are read from the declared frame of the view, as the measured card moves only its left edge.
  const declared = host.surfaces.find((item) => item.id === surface);
  if (!declared?.frame?.width) throw new Error(`the floor page view ${surface} has no declared frame`);
  const { x, y, width, height } = declared.frame;
  const marks = { head: y - 2, top: y, bottom: y + height, cx: x + width - 24, colour: FLOOR_COLOUR };
  const root = viewDocument(host, surface);
  const targetRect = { x: root.frame.x, y: root.frame.y, width: root.frame.width, height: root.frame.height };
  return { capture: () => captureFloorDrag(s, configDir, { marks, cornerRadiusPt, slotInsetsPt, targetRect }) };
}

/** Runs the captured drag that prepareFloorDrag prepared and returns its evidence. */
async function captureFloorDrag(s, configDir, { marks, cornerRadiusPt, slotInsetsPt, targetRect }) {
  const run = await drag(s, VIEW_DRAG_PLAN, { capture: true });
  mkdirSync(join(configDir, "logs"), { recursive: true });
  const directory = mkdtempSync(join(configDir, "logs", "view-drag-benchmark-"));
  writeDragLayouts(directory, run.layouts);
  const files = frames(run.frames);
  assert.equal(files.length, run.count, "the benchmark recording omitted a frame file");
  assert.ok(files.length > 30, "the benchmark has too few captured frames");

  const samples = [];
  const shown = [];
  let previous = null;
  let repeatedFrames = 0;
  const unmeasured = [];
  const geometryFrames = [];
  const geometryUnmeasured = [];
  for (const [frameIndex, file] of files.entries()) {
    const frame = readFrame(file);
    const repeated = previous !== null && frameChange(previous, frame) === null;
    previous = frame;
    if (repeated) repeatedFrames++;
    try {
      const geometry = measureViewFrameGeometry(frame, { ...FLOOR_GEOMETRY,
        colorTolerance: VIEW_GEOMETRY_COLOR_TOLERANCE, cornerRadiusPt, targetRect });
      geometryFrames.push(dragGeometryFrame(frameIndex, geometry, slotInsetsPt));
    } catch (error) {
      geometryUnmeasured.push({ frameIndex, error: error.message });
    }
    const at = outside(frame, marks);
    if (!at) {
      unmeasured.push(frameIndex);
      continue;
    }
    samples.push({ time: frame.time, position: at.card.l / at.scale });
    if (!repeated) shown.push(samples.at(-1));
  }
  assert.ok(samples.length > files.length * 0.5,
    `only ${samples.length}/${files.length} frames have measured geometry`);
  assertRoundTrips(samples.map((sample) => sample.position), 2);
  assertHeldStatesShown(samples, run.ticks, run.boundary);
  const lag = pointerLag(shown, run.ticks, run.boundary);
  const refreshRate = (await s.get("host.window")).refreshRate;
  const times = shownTimes(shown, run.ticks);
  const performance = measureDragPerformance(times, lag, refreshRate);
  const report = {
    host: s.app.name,
    performance,
    repeatedFrames,
    mode: { performanceTrace: false, logPolicy: {}, recording: true },
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
