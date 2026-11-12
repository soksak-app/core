// The split, resize, reload and WebView churn stress, shared by the window check e2e/split-load-memory.test.mjs, which runs one round and
// judges only the behaviour, and its benchmark e2e/benchmark/split-load.test.mjs, which runs SPLIT_LOAD_ROUNDS rounds and judges the host
// RSS growth against SPLIT_LOAD_GROWTH_BOUND_KB. Each round splits a card of fixture tabs (STRESS_TABS) off the card of the start tab
// and closes it, and samples the resident set size of the host process from the process table.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";

import { hostProcess } from "../../../scripts/measure-app-usage.mjs";
import { fresh } from "../../fixture.mjs";
import { processTable } from "@soksak/window-check/process-table.mjs";
import { failureWithSlowestPhase, phasedSession } from "../../reload-phases.mjs";
import { b3Conditions, fixtureSettings } from "./b3-run.mjs";
import { B3_SETTINGS } from "../measurements.mjs";
import { performanceGoalBound } from "./performance-goals.mjs";

/**
 * The tabs of the card that each round splits off and closes, by plugin: the plain view probe (a view and a document region with one line of text),
 * the layout probe (a view and its plugin document region) and the raster probe (a view, a native image region and its sidecar).
 */
export const STRESS_TABS = Object.freeze(["probeplain", "layoutprobe", "rasterprobe"]);

/** The number of rounds of the benchmark. */
export const SPLIT_LOAD_ROUNDS = 32;
/** The limit (KB) of the host RSS growth over the rounds; a growth at the limit fails. */
export const SPLIT_LOAD_GROWTH_BOUND_KB = performanceGoalBound("SPLIT_LOAD_GROWTH_BOUND_KB", "below");

/**
 * The resident set size (KB) of the host process of the configuration folder `configDir` in `table`, the output of
 * `ps -ax -o pid=,rss=,command=`: the one process whose command line has `--config-dir` of the folder (hostProcess of
 * scripts/measure-app-usage.mjs), so the host of a release bundle and of a debug build of any application is found alike. realPath is
 * the real path of the folder. A row without a pid and a size, no such host and two such hosts are errors.
 */
export function hostRssKbOf(table, configDir, realPath) {
  const rows = table.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) throw new Error(`process row "${line}" has no pid and resident size`);
    return { pid: Number(match[1]), rss: Number(match[2]), command: match[3] };
  });
  const { pid } = hostProcess(rows, configDir, realPath);
  return rows.find((row) => row.pid === pid).rss;
}

/** The resident set size (KB) of the host process of the configuration folder of the application now. */
function hostRssKb(configDir) {
  return hostRssKbOf(processTable("pid=,rss=,command="), configDir, realpathSync(configDir));
}

/**
 * List of the web documents that the window holds. If a split and a reload leave documents, document regions and image regions, the list grows. The memory of the page process
 * is not judged because WebKit keeps the previous reloaded document until memory pressure (docs/operations/private-native-apis.md).
 */
export function inventory(window) {
  return JSON.stringify({ webviews: window.webviews.length, surfaces: window.surfaces.map((surface) => surface.id).sort(),
    documents: window.documents.length, regions: window.regions.length });
}

function gridCards(grid) {
  return grid.cards.filter((card) => card.pane !== null);
}

/**
 * The fixture options (fresh of e2e/fixture.mjs) of the stress: the settings of split-load in B3_SETTINGS, whose performance trace is off
 * whatever SOKSAK_PERFORMANCE_TRACE holds. The check times the phases of each round itself (phasedSession), so the stress stores no
 * event class of the application for them.
 */
export const STRESS_FIXTURE = Object.freeze(fixtureSettings(B3_SETTINGS["split-load"]));

/**
 * Resets the fixture and reads the start state of the stress: the card that holds the start tab, which each round splits, the window,
 * the card grid, the document inventory, the host RSS before the stress, and the B3 conditions of the prepared window. The phases of
 * the rounds are timed through `requests` (phasedSession), and each phase is written to the output of the check when it ends, so a
 * timeout still names the last phase.
 */
export async function startStress(s, app) {
  const start = await fresh(s, STRESS_FIXTURE);
  const conditions = await b3Conditions(s, B3_SETTINGS["split-load"]);
  const initialWindow = await s.get("host.window");
  const initialGrid = await s.get("core.grid");
  const source = initialGrid.cards.find((card) => card.tabs?.some((tab) => tab.id === start.surface))?.id;
  assert.ok(source, `the start tab ${start.surface} is in no card of the stress layout`);
  const baseline = hostRssKb(app.configDir);
  assert.ok(Number.isInteger(baseline), "host RSS was not measurable before stress");
  const phases = [];
  const requests = phasedSession(s, (phase) => {
    phases.push(phase);
    s.step(`phase ${phase.phase} ${Math.round(phase.micros / 1000)} ms ${phase.ok ? "ok" : "failed"}`);
  });
  return {
    app,
    requests,
    source,
    conditions,
    initialWindow,
    initialGrid,
    before: inventory(initialWindow),
    samples: [baseline],
    created: [],
    phases,
  };
}

/**
 * One round: a split of the source card with a card of the tabs STRESS_TABS, a resize, three reloads, the close of the split card, and
 * the host RSS before and after the close. Each request of the round is a phase (phasedSession of reload-phases.mjs).
 */
export async function stressRound(ctx, round) {
  const { initialWindow, requests } = ctx;
  const before = await requests.get("core.grid");
  const source = gridCards(before).find((card) => card.id === ctx.source);
  assert.ok(source, `stress layout has no source card ${ctx.source}`);
  await requests.run("core.card.focus", { card: source.id });
  await requests.until("core.grid", (grid) => grid.cards.find((card) => card.id === source.id)?.focused === true,
    `stress source card ${source.id} did not focus`);
  const [first, ...more] = STRESS_TABS;
  const result = await requests.run("core.card.split", { card: source.id, side: "right", plugin: first });
  const made = [result.card];
  ctx.created.push(result.card);
  await requests.until("core.grid", (grid) => grid.cards.some((card) => card.id === result.card),
    `split ${result.card} did not appear`);
  for (const plugin of more) await requests.run("core.card.add-tab", { card: result.card, plugin });
  await requests.until("core.grid", (grid) => grid.cards.find((card) => card.id === result.card)?.tabs?.length === STRESS_TABS.length,
    `split ${result.card} did not hold the tabs ${STRESS_TABS.join(", ")}`);
  const width = round % 2 === 0 ? Math.max(640, initialWindow.content.width - 240) : initialWindow.content.width + 160;
  await requests.run("host.window.resize", { width, height: initialWindow.content.height });
  await requests.until("host.window", (window) => window.content.width === width, `stress resize did not reach ${width}`);
  await requests.presented();
  for (let reload = 0; reload < 3; reload++) {
    await requests.run("host.window.reload");
    await requests.presented();
  }
  ctx.samples.push(hostRssKb(ctx.app.configDir));
  for (const card of made.reverse()) {
    await requests.run("core.card.close", { card });
    await requests.until("core.grid", (grid) => !grid.cards.some((entry) => entry.id === card), `stress close did not remove ${card}`);
  }
  await requests.presented();
  ctx.samples.push(hostRssKb(ctx.app.configDir));
}

/**
 * Runs `count` rounds from the round index 0. The error of a failing round names the slowest phase of the rounds that ran, the failed
 * request among them.
 */
export async function runStressRounds(ctx, count) {
  try {
    for (let round = 0; round < count; round++) await stressRound(ctx, round);
  } catch (error) {
    throw failureWithSlowestPhase(error, ctx.phases);
  }
}

/**
 * Closes the cards that the stress created and still exist, restores the window size, and asserts that the card set is the start card set.
 * The window check and the benchmark run it as the cleanup of the check.
 */
export async function restoreStress(s, ctx) {
  for (const card of [...ctx.created].reverse()) {
    const grid = await s.get("core.grid");
    if (gridCards(grid).some((entry) => entry.id === card)) {
      await s.run("core.card.close", { card });
      await s.until("core.grid", (next) => !next.cards.some((entry) => entry.id === card), `stress cleanup did not close ${card}`);
    }
  }
  await s.run("host.window.resize", {
    width: ctx.initialWindow.content.width,
    height: ctx.initialWindow.content.height,
  });
  await s.presented();
  const restored = await s.get("core.grid");
  assert.deepEqual(gridCards(restored).map((card) => card.id).sort(),
    gridCards(ctx.initialGrid).map((card) => card.id).sort(), "stress cleanup did not restore the card set");
}

/**
 * The growth (KB) of the host RSS from the first sample to the largest sample. A sample that is not an integer is an unmeasurable
 * sample and fails the stress instead of being dropped.
 */
export function hostGrowthKb(samples) {
  if (!samples.every(Number.isInteger)) throw new Error(`stress produced an unmeasurable host RSS sample: ${samples.join(", ")}`);
  return Math.max(...samples) - samples[0];
}

/**
 * Fails when the host RSS growth is at or over SPLIT_LOAD_GROWTH_BOUND_KB. A growth that is not a finite number is rejected rather than compared.
 */
export function assertSplitLoadWithinBound(growth) {
  if (!Number.isFinite(growth)) throw new TypeError(`the host RSS growth must be a finite number of KB, found ${growth}`);
  if (growth >= SPLIT_LOAD_GROWTH_BOUND_KB) {
    throw new Error(`host RSS grew ${growth} KB during split/WebView stress; the bound is ${SPLIT_LOAD_GROWTH_BOUND_KB} KB`);
  }
}

/** The B3 value of the split load (e2e/benchmark/split-load.test.mjs): the host RSS growth over the rounds in KB (hostGrowthKb). */
export function splitLoadB3Values(samples) {
  return { hostGrowthKb: hostGrowthKb(samples) };
}
