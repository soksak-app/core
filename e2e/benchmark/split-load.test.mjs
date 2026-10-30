// Runs SPLIT_LOAD_ROUNDS split, resize, reload and WebView churn rounds and judges the host RSS growth against SPLIT_LOAD_GROWTH_BOUND_KB
// (cases/split-load.mjs). The window check e2e/split-load-memory.test.mjs runs one round and judges only the behaviour.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { assertSplitLoadWithinBound, hostGrowthKb, restoreStress, runStressRounds, SPLIT_LOAD_ROUNDS, startStress } from "./cases/split-load.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: split, resize, reload, and WebView churn cost at most 128 MB of host RSS growth`, { timeout: 600000 }, async (t) => {
    const session = await open(t, app);
    const ctx = await startStress(session, app);
    session.cleanup(() => restoreStress(session, ctx));
    await runStressRounds(session, ctx, SPLIT_LOAD_ROUNDS);
    const growth = hostGrowthKb(ctx.samples);
    t.diagnostic(`${app.name}: rounds ${SPLIT_LOAD_ROUNDS}; host RSS samples ${ctx.samples.join(" ")} KB; growth ${growth} KB; phases ${ctx.phases.length}`);
    assertSplitLoadWithinBound(growth);
  });
}
