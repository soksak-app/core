// Measures the floor of a view drag: the same width drag and recording as the plugin view benchmarks, on a view without plugin code. It reports
// the in-gesture source intervals, which the view traces, because the floor is an input of the targets; the recording is the evidence of
// the drag.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { rightEdgeWidthDragPlan, withViewContentTrace } from "@soksak/window-check/view-metrics-collection.mjs";
import { sourceIntervalSummary } from "./cases/plain-view.mjs";

const descriptor = Object.freeze({
  plugin: "probeplain",
  startContentTrace: (s, surface) => s.run("probeplain.measure", { action: "start" }, surface),
  stopContentTrace: (s, surface) => s.run("probeplain.measure", { action: "stop" }, surface),
});

/** Prepares the window, opens the probe, which every check configuration has installed, to the right of a card and returns the session state of its drag. */
async function openProbe(s, prepare) {
  await prepare();
  const anchor = (await s.get("core.grid")).cards.find((item) => item.pane !== null);
  const split = await s.run("core.card.split", { card: anchor.id, side: "right", plugin: descriptor.plugin });
  // The view registers its command after its phase ready, so a trace that starts at once can reach a view without it.
  await s.registered(split.tab, ["command probeplain.measure"]);
  const grid = await s.get("core.grid");
  await s.presented();
  return { surface: split.tab, grid, card: grid.cards.find((item) => item.id === split.card) };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the drag of a view without plugin code reports the floor of its source intervals`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface, grid, card } = await openProbe(s,
      () => fresh(s, { log: { frame: "trace" }, reads: ["plugin.probeplain.view.content_frame"] }));
    const traced = await withViewContentTrace(t, s, descriptor, surface, () =>
      drag(s, rightEdgeWidthDragPlan(grid, card), { capture: true }));
    const run = traced.action;
    const summary = sourceIntervalSummary(traced.contentFrames, run.ticks[0], run.ticks.at(-1));
    const directory = join(app.configDir, "logs", "plain-view-benchmark");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${process.pid}.json`), `${JSON.stringify({ summary, contentFrames: traced.contentFrames, ticks: run.ticks }, null, 2)}\n`);
    t.diagnostic(`${app.name}: source intervals ${JSON.stringify(summary)}, recording ${run.frameDir}, ${run.count} written, ` +
      `${run.missed} missed and ${run.late} late stills`);
    assert.ok(summary.count > 1, "the gesture has too few source frames");
    await s.run("core.tab.close", { tab: surface });
  });
}
