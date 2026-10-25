// Records two round trips that move 250pt in 400ms and checks the display of the surface inside its card.
import assert from "node:assert/strict";
import { availableParallelism, loadavg } from "node:os";
import test from "node:test";

import { APPS, drag, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh, reading } from "./fixture.mjs";
import { currentEventOffsets, readEvents, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { supplierDrawDurations } from "./supplier-draw.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { outside, terminalMarks, whitePixels } from "./outside.mjs";
import { alignment, alignmentDelta } from "./alignment.mjs";
import { assertDragFrameCadence, assertHeldStatesShown, assertRoundTrips, lagStages, pointerLag, transactionCadence } from "./drag-measurement.mjs";

// Vertical line 1 is the boundary between the left fixed sidebar and the terminal card. Dragging it moves the left edge of the terminal card.
const PLAN = { axis: "x", line: 1, dx: 250, dy: 0, ms: 400, times: 2 };

const READ = 0.5;

// The time for which a layout may stay on the screen after the grid left it. It is a number of frames of the display refresh period
// (docs/spec/native-surfaces.md). A display passes the boundaries of the input arrival, the frame of the previous layout, the WebKit rendering update and the display vsync,
// so the maximum is 4 frames, and the usual delay is within a median of 2.5 frames and a p90 of 3 frames.
const LAG_FRAMES = { median: 2.5, p90: 3, worst: 4 };

function assertAligned(run, marks, refreshRate) {
  const files = frames(run.frames);
  assert.ok(files.length > 30, `only ${files.length} frames were recorded`);

  let worst = { out: 0, frame: -1, at: null };
  let read = 0;
  let broke = 0;
  const positions = [];
  const samples = [];
  const times = [];
  let initial = null;
  let delayed = { delta: 0, frame: -1, geometry: null };
  files.forEach((path, index) => {
    const frame = readFrame(path);
    times.push(frame.time);
    const at = outside(frame, marks);
    if (!at) return;
    const geometry = alignment(frame, at);
    assert.equal(geometry.missing, undefined, `frame ${index} of ${files.length}: could not measure the ${geometry.missing}`);
    initial ??= geometry;
    const delta = alignmentDelta(initial, geometry);
    if (delta > delayed.delta) delayed = { delta, frame: index, geometry };
    read++;
    positions.push(at.card.l / at.scale);
    samples.push({ time: frame.time, position: at.card.l / at.scale });
    if (at.out <= 0) return;
    broke++;
    if (at.out > worst.out) worst = { out: at.out, frame: index, at };
  });
  assert.ok(read > files.length * READ,
    `only ${read} of ${files.length} frames could be measured, so this run checked nothing. ` +
      "The surface or its card was not found in the rest.");

  assertDragFrameCadence(times);
  assertRoundTrips(positions, 2);

  const lag = pointerLag(samples, run.ticks, run.boundary);
  lag.stages = lagStages(lag, run.ticks, run.layouts);
  assert.ok(Number.isFinite(refreshRate) && refreshRate > 0, `the display refresh rate is unknown (${refreshRate})`);
  const frame = 1000 / refreshRate;
  const over = Object.entries(LAG_FRAMES).filter(([key, frames]) => (key === "worst" ? lag.lag : lag[key]) > frames * frame);
  assert.deepEqual(over.map(([key]) => key), [],
    `the card showed a layout ${lag.lag.toFixed(1)}ms after the grid left it (limits at ${refreshRate}Hz: median ` +
      `${(LAG_FRAMES.median * frame).toFixed(1)}ms, p90 ${(LAG_FRAMES.p90 * frame).toFixed(1)}ms, worst ${(LAG_FRAMES.worst * frame).toFixed(1)}ms): ` +
      `offset ${lag.shown?.toFixed(1)}pt at ${lag.time?.toFixed(1)}ms matches step ${lag.step} while step ${lag.sent} was sent; ` +
      `median ${lag.median.toFixed(1)}ms, p90 ${lag.p90.toFixed(1)}ms; ` +
      `transactions ${lag.stages}; ` +
      // The display delay depends on the CPU use of other processes, so the check also writes the system load at the measurement.
      `load average ${loadavg().map((value) => value.toFixed(1)).join(" ")} on ${availableParallelism()} processors`);

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
    assert.ok(measured, `${message}: terminal/card geometry could not be measured in frame ${frameIndex}`);
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
  test(`${app.name}: native content, cards, and the sidebar rail stay aligned`, async (t) => {
    const s = await open(t, app);
    const terminal = await fresh(s, { log: { frame: "debug" }, reads: ["sidecar.vt.frame"] });
    // The right override of the terminal ties the fixed sidebar and the rail to the terminal card.
    await keepCommonSettings(s);
    await s.run("core.settings.link", { place: "window-right", plugin: "terminal", set: "set-install", scope: "common" });
    await s.until("core.rail", (rail) => rail.groups.length === 1, "the terminal override drew no rail");
    const marks = await terminalMarks(s, { measured: true });
    const offsets = currentEventOffsets(app.configDir);
    const run = await drag(t, s, PLAN, { capture: true });
    await s.flushLog();
    let supplierFrames = [];
    await untilEventLines(app.configDir, offsets, () => {
      supplierFrames = readEvents(app.configDir, offsets).events.filter((event) =>
        event.event === "sidecar.vt.frame" && event.surface === terminal.surface
        && event.mono_ns / 1e6 >= run.ticks[0] && event.mono_ns / 1e6 <= run.displayed);
      return supplierFrames.some(({ fields }) => ["draw_us", "image", "raster"].some((name) => Object.hasOwn(fields, name)));
    }, 10000, reading(app, ["sidecar.vt.frame"]));
    const { draw, nonDraw } = supplierDrawDurations(supplierFrames);
    t.diagnostic(`supplier frame records without a raster draw: ${nonDraw}`);
    t.diagnostic(`supplier frame draw (ms): count ${draw.length}, median ${draw[Math.floor(draw.length / 2)].toFixed(3)}, ` +
      `p90 ${draw[Math.floor(draw.length * .9)].toFixed(3)}, max ${draw.at(-1).toFixed(3)}`);
    // The transaction period is reported before the delay judgment. Even if the judgment fails, that period stays in the output (F92).
    t.diagnostic(`transaction cadence (ms): ${JSON.stringify(transactionCadence(run.layouts))}`);
    const lag = assertAligned(run, marks, (await s.get("host.window")).refreshRate);
    t.diagnostic(`pointer lag: worst ${lag.lag.toFixed(1)}ms, p90 ${lag.p90.toFixed(1)}ms, median ${lag.median.toFixed(1)}ms; transactions ${lag.stages}`);
    t.diagnostic(`page handling per step (ms), first 12: ${JSON.stringify(run.handled?.slice(0, 12))}, steps 40-51: ${JSON.stringify(run.handled?.slice(40, 52))}`);
  });

  test(`${app.name}: terminal divider drag does not leave a white surface frame`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // Drags the boundary between the left fixed sidebar and the terminal card.
    const marks = await terminalMarks(s, { measured: true });
    const narrow = await drag(t, s,
      { axis: "x", line: 1, dx: 290, dy: 0, ms: 96, times: 4 }, { capture: true });
    assertNoWhiteSurfaceBleed(narrow, "terminal divider drag to narrow", marks);
    const wide = await drag(t, s,
      { axis: "x", line: 1, dx: -70, dy: 0, ms: 96, times: 4 }, { capture: true });
    assertNoWhiteSurfaceBleed(wide, "terminal divider drag back to wide", marks);
  });
}

// The terminal surface has the same color as the card, so pixels cannot separate the native position from the width of the document. The check compares the size that the surface document reports
// (core.surface.document) with the native position that the host placed (host.window).
async function assertDocumentFillsFrame(s, surface, label) {
  await s.presented();
  const frame = (await s.get("host.window")).surfaces.find((item) => item.id === surface)?.frame;
  assert.ok(frame?.width > 0, `${label}: the terminal surface ${surface} has no native frame`);
  const { body, viewport } = await s.get("core.surface.document", surface);
  for (const [name, size] of [["body", body], ["viewport", viewport]]) {
    assert.ok(Math.abs(size.width - frame.width) <= 0.5 && Math.abs(size.height - frame.height) <= 0.5,
      `${label}: the terminal document ${name} is ${size.width}×${size.height} in a native frame of ${frame.width}×${frame.height}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the terminal document fills its native frame before and after a divider drag`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const surface = (await s.get("core.grid")).cards.find((card) => card.id === "terminal").active;
    await assertDocumentFillsFrame(s, surface, "at rest");
    await drag(t, s, { axis: "x", line: 1, dx: 250, dy: 0, ms: 96, times: 1 });
    await assertDocumentFillsFrame(s, surface, "after the drag");
  });
}
