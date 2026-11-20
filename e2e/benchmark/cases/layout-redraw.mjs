// The frames in which the image regions of cards show nothing while the layout changes (e2e/benchmark/layout-redraw.test.mjs). A
// grid of two rows of three raster probe cards (openRasterGrid of raster-cards.mjs, not balanced, so the widths of a row differ)
// paints each card in its own colour with three row bands, the text of the card. The window is recorded (Session.record of
// @soksak/window-check, a still each display refresh) while the benchmark runs in turn: core.layout.balance, the command of the
// auto-arrange button; a native drag of the divider after the first card of the top row (diagnostics.drag); and, when the build
// declares core.group.leader, the leader moved to the second card of the top row and back to the first. After each action it waits
// until every card presents a frame of the size of its region and the window presented that state.
//
// For each action the frames are those requested from the clock before the action to the display time of the presented state; the
// colour of each card is read at the centre of its image region in the last frame completed before the action. A frame is blank for
// a card when it holds no pixel of the colour of that card: the region shows none of its raster. The benchmark counts the blank
// frames per action and card and the smallest share of the pixels of the colour that a frame kept against the frame before the
// action, and judges none of them: the stills are evidence that no check judges (docs/spec/diagnostics.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { drag } from "@soksak/window-check/app.mjs";
import { transactionCadence } from "@soksak/window-check/drag-measurement.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
import { traceSettings } from "../../../scripts/measure-trace.mjs";
import { fresh } from "../../fixture.mjs";
import { imagePoint } from "../../input-probe.mjs";
import { presentedFrame, REGION } from "../../raster-probe.mjs";
import { fixtureSettings } from "./b3-run.mjs";
import { colourCounts, pixelAt, readFrame } from "./frame-pixels.mjs";
import { openRasterGrid } from "./raster-cards.mjs";

/** The grid of the benchmark, the colours of its cards in the order of the grid, and the row bands of each card. */
export const REDRAW_GRID = Object.freeze({ rows: 2, columns: 3 });
export const CARD_COLOURS = Object.freeze(["#d02020", "#20d020", "#2020d0", "#d0d020", "#20d0d0", "#d020d0"]);
const BANDS = 3;
/** The largest difference of a channel between a pixel and the colour of a card that counts the pixel as that colour. */
export const TOLERANCE = 3;
/** The divider drag: the line moves 80 points to the left and back over 600 ms once, with native pointer input. */
const DRAG = Object.freeze({ axis: "x", dx: -80, dy: 0, ms: 600, times: 1, native: true });

/** The milliseconds of the clock of the recorded frames now (diagnostics.clock, docs/spec/endpoint.md). */
export async function clockMs(s) {
  const { mono_ns: ns } = await s.request("diagnostics.clock");
  return Number(BigInt(ns) / 1000n) / 1000;
}

/** The request and completion time (ms) in the header of the frame file `path`; the pixels are not restored. */
export function frameTimes(path) {
  const file = readFileSync(path);
  if (file.length < 88) throw new Error(`${path} has no complete frame header`);
  return { path, requested: file.readDoubleLE(12 + 6 * 8), completed: file.readDoubleLE(12 + 7 * 8) };
}

/**
 * The frames of one action among `times` (frameTimes, in the order of the stills) from `from` to `to` (ms): `before`, the last frame
 * completed at or before `from`, and `during`, the frames requested from `from` to `to`. An action without a frame before it or
 * without a frame during it is an error, because nothing could be compared.
 */
export function actionFrames(times, { action, from, to }) {
  const before = times.filter((frame) => frame.completed <= from).at(-1);
  const during = times.filter((frame) => frame.requested >= from && frame.requested <= to);
  if (before === undefined) throw new Error(`the recording holds no frame completed before ${action} at ${from} ms`);
  if (during.length === 0) throw new Error(`the recording holds no frame requested during ${action} from ${from} to ${to} ms`);
  return { before, during };
}

/**
 * The figures of one action from `base`, the counts of the colour of each card in the frame before it, and `counts`, the counts of
 * each frame during it (colourCounts): for each card the frames that hold no pixel of its colour and the smallest share of its
 * pixels that a frame kept. A card without a pixel of its colour before the action is an error.
 */
export function blankFigures(cards, base, counts) {
  return cards.map((card, index) => {
    if (base[index] === 0) throw new Error(`the card ${card} shows no pixel of its colour before the action`);
    const shares = counts.map((frame) => frame[index] / base[index]);
    return { card, blank: counts.filter((frame) => frame[index] === 0).length, fewestShare: Math.min(...shares) };
  });
}

/**
 * The raster of the image region of the raster probe tab `surface` in the value `host` of host.window: its frame in device pixels,
 * each side rounded as the host rounds it (sp_region_raster of native/darwin/src/image_region.m). The size of the view
 * (rasterprobe.view) is no measure of it, because the view reports a whole point where the region stands a half point wider.
 */
export function regionRaster(host, surface) {
  const region = host.regions.find((item) => item.surface === surface && item.name === REGION);
  if (region === undefined) throw new Error(`host.window names no image region raster of ${surface}`);
  return { width: Math.round(region.frame.width * host.scale), height: Math.round(region.frame.height * host.scale) };
}

/**
 * Waits until every raster probe tab `surfaces` presents a frame of the raster of its region (regionRaster) and the window
 * presented that state, and returns the display time (ms) of the presented state.
 */
async function settled(s, surfaces) {
  await s.presented();
  const host = await s.get("host.window");
  for (const surface of surfaces) {
    const { width, height } = regionRaster(host, surface);
    await presentedFrame(s, surface, (frame) => frame.width === width && frame.height === height, `a frame of ${width}x${height} pixels`);
  }
  return (await s.presented()).displayed;
}

/**
 * The stages of the layout transactions `layouts` of a divider drag (the layouts of the reply of diagnostics.drag,
 * docs/spec/endpoint.md): the number of transactions of each commit path, `none` for one that did not commit, and the spread of
 * their stages (transactionCadence of @soksak/window-check/drag-measurement.mjs), so a slow drag names the stage that took its time.
 */
export function dragStages(layouts) {
  const paths = {};
  for (const layout of layouts) {
    const path = layout.commitPath ?? "none";
    paths[path] = (paths[path] ?? 0) + 1;
  }
  return { paths, cadence: transactionCadence(layouts) };
}

/**
 * The report line of the stages `stages` (dragStages). A workbench that draws a drag without a native layout transaction, as the
 * mygo workbench does, has no stage to spread, and the line says so instead of printing empty figures.
 */
export function stageLine(stages) {
  if (stages.cadence.total.count === 0) return "no layout transaction: the workbench drew the drag without a native layout transaction";
  const spread = (name) => `${name} ${stages.cadence[name].count} median ${stages.cadence[name].median.toFixed(1)} p90 ${stages.cadence[name].p90.toFixed(1)} ms`;
  return `transactions by commit path ${JSON.stringify(stages.paths)}; ` + ["interval", "drawing", "waiting", "committing", "total"].map(spread).join("; ");
}

/** The actions of the benchmark for the grid `grid` (rows of {card}), with the leader actions when `leader` is declared. */
export function redrawActions(grid, line, leader) {
  const actions = [
    { action: "balance", run: (s) => s.run("core.layout.balance", {}) },
    { action: "divider drag", run: (s) => drag(s, { ...DRAG, line }) },
  ];
  if (leader) {
    actions.push({ action: "leader", run: (s) => s.run("core.group.leader", { card: grid[0][1].card }) });
    actions.push({ action: "leader back", run: (s) => s.run("core.group.leader", { card: grid[0][0].card }) });
  }
  return actions;
}

/**
 * Runs the benchmark in the window of `s` and returns `{leader, frames, actions}`: whether the build declares core.group.leader,
 * the number of recorded frames, and for each action its frames and the figures of each card (blankFigures).
 */
export async function runRedraw(s) {
  await fresh(s, fixtureSettings(traceSettings(0)));
  const grid = await openRasterGrid(s, { ...REDRAW_GRID, balance: false });
  const cards = grid.flat();
  for (const [index, { surface }] of cards.entries()) {
    await s.run("rasterprobe.color", { color: CARD_COLOURS[index] }, surface);
    await s.run("rasterprobe.rows", { count: BANDS }, surface);
  }
  for (const [index, { surface }] of cards.entries()) {
    await presentedFrame(s, surface, (frame) => frame.color === CARD_COLOURS[index] && frame.rows === BANDS, `a frame in ${CARD_COLOURS[index]}`);
  }
  const leader = (await s.request("exposure.list")).commands.some((entry) => entry.name === "core.group.leader");
  const line = (await s.get("core.grid")).cards.find((card) => card.id === grid[0][0].card).c1;
  const recording = await s.record();
  const windows = [];
  let displayed = await settled(s, cards.map(({ surface }) => surface));
  for (const { action, run } of redrawActions(grid, line, leader)) {
    const points = [];
    for (const { surface } of cards) points.push(await imagePoint(s, surface));
    const from = await clockMs(s);
    s.step(`action ${action}`);
    const result = await run(s);
    displayed = await settled(s, cards.map(({ surface }) => surface));
    windows.push({ action, from, to: displayed, points, stages: action === "divider drag" ? dragStages(result.layouts) : null });
  }
  const stopped = await recording.stop({ after: displayed });
  if (stopped === null) throw new Error(`the recording ${recording.frames} did not stop; its notes tell why`);
  const times = frames(recording.frames).map(frameTimes);
  const actions = windows.map(({ action, from, to, points, stages }) => {
    const { before, during } = actionFrames(times, { action, from, to });
    const first = readFrame(before.path);
    const colours = points.map((point) => pixelAt(first, point));
    const distinct = new Set(colours.map((colour) => colour.join(",")));
    if (distinct.size !== colours.length) throw new Error(`the cards show the colours ${JSON.stringify(colours)} before ${action}, not one colour each`);
    const base = colourCounts(first, colours, TOLERANCE);
    const counts = during.map(({ path }) => colourCounts(readFrame(path), colours, TOLERANCE));
    return { action, frames: during.length, cards: blankFigures(cards.map(({ card }) => card), base, counts), stages };
  });
  return { leader, frames: times.length, folder: join(recording.frames), actions };
}
