// Records two round trips that move 250pt in 400ms and checks the display of the surface inside its card. The surface is a raster
// probe in the card to the right of the left fixed sidebar; its fake sidecar paints its image region in the measured color.
import assert from "node:assert/strict";
import { availableParallelism, loadavg } from "node:os";
import test from "node:test";

import { APPS, drag, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh, probeListSections, reading } from "./fixture.mjs";
import { CHECK_SET } from "@soksak/window-check/start.mjs";
import { currentEventOffsets, readEvents, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { supplierDrawDurations } from "./supplier-draw.mjs";
import { frameChange, frames, readFrame } from "@soksak/window-check/frame.mjs";
import { outside, rasterMarks, whitePixels } from "./outside.mjs";
import { addRasterTabAt, RASTER } from "./raster-probe.mjs";
import { alignment, alignmentDelta } from "./alignment.mjs";
import { measureDragPerformance, shownTimes, assertFinalContentSize, assertHeldStatesShown, assertRoundTrips, lagStages, pointerLag, transactionCadence } from "@soksak/window-check/drag-measurement.mjs";

// Vertical line 1 is the boundary between the left fixed sidebar and the first card of the middle column. Dragging it moves the left
// edge of that card.
const PLAN = { axis: "x", line: 1, dx: 250, dy: 0, ms: 400, times: 2 };

const READ = 0.5;


/** Adds a raster probe tab to the first card of the middle column, whose left edge is line 1, and returns `{card, surface}`. */
const rasterInFirstCard = (s) => addRasterTabAt(s, 1, 0);

function assertAligned(run, marks, refreshRate) {
  const files = frames(run.frames);
  assert.equal(files.length, run.count, "the drag recording omitted a saved frame");
  assert.ok(files.length > 30, `only ${files.length} frames were recorded`);

  let worst = { out: 0, frame: -1, at: null };
  let read = 0;
  let broke = 0;
  const positions = [];
  const samples = [];
  const shown = [];
  let previous = null;
  const sizes = [];
  let initial = null;
  let delayed = { delta: 0, frame: -1, geometry: null };
  files.forEach((path, index) => {
    const frame = readFrame(path);
    const repeated = previous !== null && frameChange(previous, frame) === null;
    previous = frame;
    const at = outside(frame, marks);
    sizes.push({ time: frame.time, left: at?.left ?? null, right: at?.right ?? null });
    if (!at) return;
    const geometry = alignment(frame, at);
    assert.equal(geometry.missing, undefined, `frame ${index} of ${files.length}: could not measure the ${geometry.missing}`);
    initial ??= geometry;
    const delta = alignmentDelta(initial, geometry);
    if (delta > delayed.delta) delayed = { delta, frame: index, geometry };
    read++;
    positions.push(at.card.l / at.scale);
    samples.push({ time: frame.time, position: at.card.l / at.scale });
    if (!repeated) shown.push(samples.at(-1));
    if (at.out <= 0) return;
    broke++;
    if (at.out > worst.out) worst = { out: at.out, frame: index, at };
  });
  assert.ok(read > files.length * READ,
    `only ${read} of ${files.length} frames could be measured, so this run checked nothing. ` +
      "The surface or its card was not found in the rest.");

  assertFinalContentSize(sizes, run.ticks.at(-1));

  assert.ok(delayed.delta <= 1,
    `native content, card, sidebar, and rail geometry differ by ${delayed.delta.toFixed(1)}pt in frame ` +
      `${delayed.frame} of ${files.length}: initial ${JSON.stringify(initial)}, frame ${JSON.stringify(delayed.geometry)}`);

  const { at } = worst;
  assert.equal(broke, 0,
    `${broke} of ${read} measured frames draw the surface outside its own card. The worst is frame ` +
      `${worst.frame}, ${worst.out.toFixed(1)}pt out` +
      (at?.onNeighbour > 0 ? `, ${at.onNeighbour.toFixed(1)}pt of it over the neighbouring card` : "") +
      (at ? `: the card spans ${at.card.l}..${at.card.r} and the surface ${at.surface.l}..${at.surface.r} ` +
        `on row ${at.row}, at ${at.scale} pixels to the point` : ""));
  assertRoundTrips(positions, 2);

  const lag = pointerLag(shown, run.ticks, run.boundary);
  lag.stages = lagStages(lag, run.ticks, run.layouts);
  lag.performance = measureDragPerformance(shownTimes(shown, run.ticks), lag, refreshRate);

  return lag;
}

function assertNoWhiteSurfaceBleed(run, message, marks) {
  const files = frames(run.frames);
  assert.ok(files.length > 0, `${message}: no frames were recorded`);
  const samples = [];
  let worst = { ratio: 0, frame: -1 };
  for (const [frameIndex, path] of files.entries()) {
    const frame = readFrame(path);
    const measured = outside(frame, marks);
    assert.ok(measured, `${message}: surface/card geometry could not be measured in frame ${frameIndex}`);
    const { l, r } = measured.card;
    samples.push({ time: frame.time, position: l / measured.scale });
    // During the horizontal drag, the top and the bottom of the surface do not move. The check measures from the top to the bottom of the surface, between the card borders.
    const y0 = Math.round(marks.top * frame.scale);
    const y1 = Math.round(marks.bottom * frame.scale);
    const left = l + measured.scale, right = r - measured.scale + 1;
    const white = whitePixels(frame, { l: left, r: right, t: y0, b: y1 });
    const ratio = white / ((right - left) * (y1 - y0));
    if (ratio > worst.ratio) worst = { ratio, frame: frameIndex, measured, y0, y1 };
  }
  assert.equal(worst.ratio, 0,
    `${message}: white pixels ${(worst.ratio * 100).toFixed(2)}% in frame ${worst.frame} ` +
      `within card ${worst.measured?.card?.l}..${worst.measured?.card?.r}, ` +
      `rows ${worst.y0}..${worst.y1}`);
  // Each step is 16ms, so the short return of this drag can be shorter than one display. The check requires only a layout that stayed for a long time.
  assertHeldStatesShown(samples, run.ticks, run.boundary);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: native content, cards, and the sidebar rail stay aligned`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { frame: "debug" }, reads: ["sidecar.rasterprobe.frame"] });
    const raster = await rasterInFirstCard(s);
    // The right override of the raster probe ties the fixed sidebar and the rail to the raster probe card. The environment of an
    // application declares the sidebar sets in place of the sets of the plugins, so the check stores a common set of the list
    // sections of the layout probe and links it; keepCommonSettings restores both when the check ends.
    await keepCommonSettings(s);
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: [...sets.filter((item) => item.id !== CHECK_SET),
      { id: CHECK_SET, title: "검사", sections: probeListSections(), layout: "list" }] }, scope: "common" });
    await s.run("core.settings.link", { place: "window-right", plugin: RASTER, set: CHECK_SET, scope: "common" });
    await s.until("core.rail", (rail) => rail.groups.length === 1, "the raster probe override drew no rail");
    const marks = await rasterMarks(s, raster.surface, { measured: true });
    const offsets = currentEventOffsets(app.configDir);
    const run = await drag(s, PLAN, { capture: true });
    t.diagnostic(`page handling per step (ms): ${JSON.stringify(run.handled)}`);
    await s.flushLog();
    let supplierFrames = [];
    await untilEventLines(app.configDir, offsets, () => {
      supplierFrames = readEvents(app.configDir, offsets).events.filter((event) =>
        event.event === "sidecar.rasterprobe.frame" && event.surface === raster.surface
        && event.mono_ns / 1e6 >= run.ticks[0] && event.mono_ns / 1e6 <= run.displayed);
      return supplierFrames.length > 0;
    }, { ...reading(app, ["sidecar.rasterprobe.frame"]), ended: s.client.ended });
    const { draw } = supplierDrawDurations(supplierFrames);
    t.diagnostic(`supplier frame draw (ms): count ${draw.length}, median ${draw[Math.floor(draw.length / 2)].toFixed(3)}, ` +
      `p90 ${draw[Math.floor(draw.length * .9)].toFixed(3)}, max ${draw.at(-1).toFixed(3)}`);
    // The transaction period is reported before the delay judgment. Even if the judgment fails, that period stays in the output (F92).
    t.diagnostic(`transaction cadence (ms): ${JSON.stringify(transactionCadence(run.layouts))}`);
    const lag = assertAligned(run, marks, (await s.get("host.window")).refreshRate);
    t.diagnostic(`performance measurements: ${JSON.stringify(lag.performance)}; system load ${JSON.stringify(loadavg())}, processors ${availableParallelism()}`);
    t.diagnostic(`pointer lag: worst ${lag.lag.toFixed(1)}ms, p90 ${lag.p90.toFixed(1)}ms, median ${lag.median.toFixed(1)}ms; transactions ${lag.stages}`);
  });

  test(`${app.name}: an image region divider drag does not leave a white surface frame`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const raster = await rasterInFirstCard(s);
    // Drags the boundary between the left fixed sidebar and the raster probe card.
    const marks = await rasterMarks(s, raster.surface, { measured: true });
    const narrow = await drag(s,
      { axis: "x", line: 1, dx: 290, dy: 0, ms: 96, times: 4 }, { capture: true });
    assertNoWhiteSurfaceBleed(narrow, "image region divider drag to narrow", marks);
    const wide = await drag(s,
      { axis: "x", line: 1, dx: -70, dy: 0, ms: 96, times: 4 }, { capture: true });
    assertNoWhiteSurfaceBleed(wide, "image region divider drag back to wide", marks);
  });
}

// The check compares the size that the surface document of the raster probe reports (core.surface.document) with the native position
// that the host placed (host.window), which pixels alone cannot separate from the width of the document.
async function assertDocumentFillsFrame(s, surface, label) {
  await s.presented();
  const frame = (await s.get("host.window")).surfaces.find((item) => item.id === surface)?.frame;
  assert.ok(frame?.width > 0, `${label}: the surface ${surface} has no native frame`);
  const { body, viewport } = await s.get("core.surface.document", surface);
  for (const [name, size] of [["body", body], ["viewport", viewport]]) {
    assert.ok(Math.abs(size.width - frame.width) <= 0.5 && Math.abs(size.height - frame.height) <= 0.5,
      `${label}: the surface document ${name} is ${size.width}×${size.height} in a native frame of ${frame.width}×${frame.height}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: an image region view document fills its native frame before and after a divider drag`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { surface } = await rasterInFirstCard(s);
    await assertDocumentFillsFrame(s, surface, "at rest");
    await drag(s, { axis: "x", line: 1, dx: 250, dy: 0, ms: 96, times: 1 });
    await assertDocumentFillsFrame(s, surface, "after the drag");
  });
}
