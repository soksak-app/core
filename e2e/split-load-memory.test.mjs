import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { inventory, restoreStress, runStressRounds, startStress } from "./benchmark/cases/split-load.mjs";
import { slowestPhase } from "./reload-phases.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: split, resize, reload, and WebView churn restore the window and end the page process`, { timeout: 120_000 }, async (t) => {
    const session = await open(t, app);
    const ctx = await startStress(session, app);
    session.cleanup(() => restoreStress(session, ctx));
    // One round of the stress (cases/split-load.mjs). The host RSS samples of the round are recorded and not judged here; the benchmark
    // e2e/benchmark/split-load.test.mjs runs the rounds and judges their growth.
    await runStressRounds(session, ctx, 1);
    // All created cards were closed, so the window holds the same documents as at the start.
    const settled = await session.until("host.window", (window) => inventory(window) === ctx.before,
      `the window documents differ from ${ctx.before} after the stress`);
    const slowest = slowestPhase(ctx.phases);
    t.diagnostic(`split-load ${JSON.stringify({ app: app.name, rounds: 1, samples: ctx.samples, documents: ctx.before,
      phases: ctx.phases.length, slowest: slowest && { phase: slowest.phase, ms: Math.round(slowest.micros / 1000) } })}`);
    // A reload opens the new document in a new page process and ends the previous process (docs/spec/native-host.md#page-reload).
    assert.notEqual(settled.pageProcess, ctx.initialWindow.pageProcess, "the reloads kept the page process");
    await session.request("diagnostics.process.exit", { pid: ctx.initialWindow.pageProcess }).catch((error) => {
      throw new Error(`the reloads left the first page process ${ctx.initialWindow.pageProcess} running: ${error.message}`);
    });
  });
}
