// Measures the floor of a view drag: the same width drag and recording as the plugin view benchmarks, on a view without plugin code. It reports
// the in-gesture source intervals and judges only that the recording covers the gesture, because the floor is an input of the targets.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { frameChange, frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { mapViewContentFramesToCapture, requireViewContentFrameCoverage, rightEdgeWidthDragPlan, withViewContentTrace } from "../view-metrics-collection.mjs";
import { cardEdgeConvergence, cardEdgeSamples, sourceIntervalSummary } from "./cases/plain-view.mjs";
import { outside } from "../outside.mjs";
import { assertRoundTrips, measureDragPerformance, pointerLag, shownTimes, transactionCadence } from "../drag-measurement.mjs";

const descriptor = Object.freeze({
  plugin: "probeplain",
  startContentTrace: (s, surface) => s.run("probeplain.measure", { action: "start" }, surface),
  stopContentTrace: (s, surface) => s.run("probeplain.measure", { action: "stop" }, surface),
});

// The colour that the recording shows for the empty document region of the probe.
const PROBE_COLOUR = [30, 30, 30];

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
  test(`${app.name}: the drag of a view without plugin code reports the floor of its latency with traces disabled`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface, grid, card } = await openProbe(s, () => fresh(s, { performanceTrace: false }));
    const { frame } = (await s.get("host.window")).surfaces.find((item) => item.id === surface);
    const marks = { head: frame.y - 2, top: frame.y, bottom: frame.y + frame.height, colour: PROBE_COLOUR };
    const run = await drag(s, { ...rightEdgeWidthDragPlan(grid, card), ms: 400, times: 2 }, { capture: true });
    const captured = frames(run.frames).map(readFrame);
    const { samples, unmeasured } = cardEdgeSamples(captured, (item) => {
      const at = outside(item, marks);
      return at ? at.card.r / at.scale : null;
    });
    const first = captured[0];
    const at = (x, y) => pixel(first, Math.round(x * first.scale), Math.round(y * first.scale));
    assert.ok(samples.length > captured.length * 0.5, `only ${samples.length}/${captured.length} frames have a measured card edge; ` +
      `surface ${JSON.stringify(frame)}, first frame scale ${first.scale}, colour at its centre ${at(frame.x + frame.width / 2, frame.y + frame.height / 2)}, ` +
      `at its head ${at(frame.x + frame.width / 2, marks.head)}`);
    assertRoundTrips(samples.map((sample) => sample.position), 2);
    const changes = captured.slice(1).map((item, index) => ({ time: item.time, change: frameChange(captured[index], item) }));
    const repeated = new Set(changes.filter((item) => item.change === null).map((item) => item.time));
    const shown = samples.filter((sample) => !repeated.has(sample.time));
    const lag = pointerLag(shown, run.ticks, run.boundary);
    const performance = measureDragPerformance(shownTimes(shown, run.ticks), lag, (await s.get("host.window")).refreshRate);
    const convergence = cardEdgeConvergence(samples, run.ticks.at(-1));
    const report = { load: loadavg(), performance, convergence, transactionCadence: transactionCadence(run.layouts), repeatedFrames: repeated.size, samples, ticks: run.ticks, boundary: run.boundary, layouts: run.layouts, times: captured.map((item) => item.time), unmeasured };
    const directory = join(app.configDir, "logs", "plain-view-latency");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${process.pid}.json`), `${JSON.stringify(report)}\n`);
    t.diagnostic(`${app.name}: latency floor ${JSON.stringify(performance)}, ${unmeasured.length} of ${captured.length} frames unmeasured`);
    await s.run("core.tab.close", { tab: surface });
  });

  test(`${app.name}: the drag of a view without plugin code reports the floor of its source intervals`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface, grid, card } = await openProbe(s,
      () => fresh(s, { log: { frame: "trace" }, reads: ["plugin.probeplain.view.content_frame"] }));
    const traced = await withViewContentTrace(t, s, descriptor, surface, () =>
      drag(s, rightEdgeWidthDragPlan(grid, card), { capture: true }));
    const run = traced.action;
    const captured = frames(run.frames).map(readFrame);
    const mapped = requireViewContentFrameCoverage(mapViewContentFramesToCapture(traced.contentFrames, captured), {
      gestureStartedAtMs: run.ticks[0], gestureEndedAtMs: run.ticks.at(-1),
    });
    const summary = sourceIntervalSummary(mapped, run.ticks[0], run.ticks.at(-1));
    const directory = join(app.configDir, "logs", "plain-view-benchmark");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${process.pid}.json`), `${JSON.stringify({ summary, contentFrames: traced.contentFrames, ticks: run.ticks }, null, 2)}\n`);
    t.diagnostic(`${app.name}: source intervals ${JSON.stringify(summary)}, ${captured.length} recorded frames, longest gap ${run.longestGap} ms`);
    assert.ok(summary.count > 1, "the gesture has too few source frames");
    await s.run("core.tab.close", { tab: surface });
  });
}
