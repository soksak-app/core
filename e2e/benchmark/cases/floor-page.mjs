// The floor page view of the view drag and resize benchmarks (docs/operations/examples.md, F502-2 and F502-25): the fixture plugin
// floorpage of e2e/fixtures/view-drag/floor-page, preinstalled with every fixture plugin, whose view page draws the measurement colour
// over its whole frame and runs no plugin code, so a drag measures the host and the web view alone. This module opens the floor page
// as the active tab of a card and prepares and runs the captured drag of the view drag benchmark, whose recording is its evidence.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drag, keepCommonSettings } from "@soksak/window-check/app.mjs";
import { transactionCadence } from "@soksak/window-check/drag-measurement.mjs";
import { commitCadence, displayPeriod, stepCommitDelays } from "@soksak/window-check/layout-timing.mjs";

/** The floor page plugin: its id and its folder. */
export const FLOOR_PAGE = Object.freeze({
  plugin: "floorpage",
  folder: fileURLToPath(new URL("../../fixtures/view-drag/floor-page/", import.meta.url)),
});

/** The colour that the floor page draws; it stays outside the colour tolerance of the antialiased focus outline of a card. */
export const FLOOR_COLOUR = Object.freeze([0, 80, 180]);

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

/** Persists the transaction rows of a drag. */
export function writeDragLayouts(directory, layouts) {
  assert.ok(Array.isArray(layouts), "drag layouts must be an array");
  const path = join(directory, "layouts.json");
  writeFileSync(path, JSON.stringify({ layouts }, null, 2) + "\n");
  return path;
}

/**
 * Prepares the untraced drag capture of the floor page view `surface`, the active tab of the card `card`: it requires the trace off
 * and the default policy and gives the floor page a window-right sidebar override. Returns { capture }: capture() runs VIEW_DRAG_PLAN
 * with capture and returns its evidence. The drags of the view drag
 * benchmark run between the preparation and the capture under this layout; a drag goes out and back, so the card returns to the
 * prepared rectangle.
 */
export async function prepareFloorDrag(t, s, { surface, card }, configDir) {
  assert.equal(process.env.SOKSAK_PERFORMANCE_TRACE, undefined,
    "the benchmark requires performance tracing to be unset");
  const { values } = await s.get("core.settings");
  assert.equal(values["diagnostics.performance"], false, "the application performance trace is enabled");
  assert.deepEqual(values["diagnostics.log"], {}, "the application is not using its default error-only log policy");
  await keepCommonSettings(s);
  await s.run("core.settings.link", { place: "window-right", plugin: FLOOR_PAGE.plugin, set: "set-install", scope: "common" });
  await s.until("core.rail", (rail) => rail.groups.length === 1, "the floor page override drew no rail");
  const grid = await s.get("core.grid");
  assert.equal(grid.cards.find((item) => item.id === card)?.active, surface,
    `the dragged view ${surface} is not the active tab of card ${card}`);
  await s.presented();
  return { capture: () => captureFloorDrag(s, configDir) };
}

/**
 * Runs the captured drag that prepareFloorDrag prepared and returns its evidence: the folder of its report and the report, which holds
 * the figures of the drag that the host reported (steps, boundary positions, layout transactions and their cadence), the folder of
 * its recording, which is its log, and the judgments of its layout trace with the display period of the window: `commits`, the intervals between
 * the commits of the view drag (commitCadence), and `stepDelays`, the delay of each layout of the divider drag from its begin to its
 * commit (stepCommitDelays) (docs/spec/native-surfaces.md).
 */
async function captureFloorDrag(s, configDir) {
  const { refreshRate } = await s.get("host.window");
  const period = displayPeriod(refreshRate);
  const run = await drag(s, VIEW_DRAG_PLAN, { capture: true });
  const during = { from: run.ticks[0], to: run.ticks.at(-1), period };
  mkdirSync(join(configDir, "logs"), { recursive: true });
  const directory = mkdtempSync(join(configDir, "logs", "view-drag-benchmark-"));
  writeDragLayouts(directory, run.layouts);
  const report = {
    host: s.app.name,
    mode: { performanceTrace: false, logPolicy: {}, recording: true },
    load: loadavg(),
    processors: availableParallelism(),
    recording: run.frameDir,
    ticks: run.ticks,
    boundary: run.boundary,
    layouts: run.layouts,
    transactionCadence: transactionCadence(run.layouts),
    refreshRate,
    commits: commitCadence(run.layouts, during),
    stepDelays: stepCommitDelays(run.layouts, during),
  };
  return { directory, report };
}
