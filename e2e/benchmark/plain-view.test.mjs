// Measures the floor of a view drag: the same width drag and recording as the plugin view benchmarks, on a view without plugin code. It reports
// the in-gesture source intervals, which the view traces, because the floor is an input of the targets; the recording is the log of the
// drag. From the content frames that the view traces and the steps and layouts that the host reports, it reports as a diagnostic the
// judgments that e2e/plain-view.test.mjs makes of the drag and of a card size change of the view (docs/spec/plugin-processes.md):
// contentCadence, contentConvergence and contentAfterChange of @soksak/window-check/layout-timing.mjs.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { contentAfterChange, contentCadence, contentConvergence } from "@soksak/window-check/layout-timing.mjs";
import { fresh } from "../fixture.mjs";
import { dragAndWiden, openPlainView, sourceIntervalSummary } from "./cases/plain-view.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the drag of a view without plugin code reports the floor of its source intervals`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const opened = await openPlainView(s,
      () => fresh(s, { log: { frame: "trace" }, reads: ["plugin.probeplain.view.content_frame"] }));
    const traced = await dragAndWiden(t, s, opened, { capture: true });
    const run = traced.action.dragged;
    const summary = sourceIntervalSummary(traced.contentFrames, run.ticks[0], run.ticks.at(-1));
    const directory = join(app.configDir, "logs", "plain-view-benchmark");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${process.pid}.json`), `${JSON.stringify({ summary, contentFrames: traced.contentFrames, ticks: run.ticks }, null, 2)}\n`);
    t.diagnostic(`${app.name}: source intervals ${JSON.stringify(summary)}, recording ${run.frameDir}`);
    assert.ok(summary.count > 1, "the gesture has too few source frames");
    const [from, end] = [run.ticks[0], run.ticks.at(-1)];
    const cadence = contentCadence(traced.contentFrames, { from, to: end });
    const converged = contentConvergence(traced.contentFrames.filter(({ timeRange }) => traced.action.changed === null
      || timeRange.upperMs < traced.action.changed), { end });
    t.diagnostic(`${app.name}: content intervals ${JSON.stringify(cadence.intervals)} ms; final size ` +
      (converged.applicable ? `${converged.took} ms after the drag` : "equal to the last size of the drag") +
      `; misses ${JSON.stringify([...cadence.failures, ...converged.failures])}`);
    if (traced.action.changed === null) {
      t.diagnostic(`${app.name}: the card size change sent no layout`);
    } else {
      const changed = contentAfterChange(traced.contentFrames, { changedAt: traced.action.changed });
      t.diagnostic(`${app.name}: the new size of the card ${changed.took} ms after the first layout of the change; misses ` +
        JSON.stringify(changed.failures));
    }
    await s.run("core.tab.close", { tab: opened.surface });
  });
}
