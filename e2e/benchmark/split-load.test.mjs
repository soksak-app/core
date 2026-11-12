// Runs SPLIT_LOAD_ROUNDS split, resize, reload and WebView churn rounds and judges the host RSS growth against SPLIT_LOAD_GROWTH_BOUND_KB
// of the performance goals (cases/split-load.mjs). The window check e2e/split-load-memory.test.mjs runs one round and judges only the
// behaviour. B3 output (SOKSAK_B3_OUT, cases/b3-run.mjs): hostGrowthKb (splitLoadB3Values), the key of split-load in B3_MEASUREMENTS of
// measurements.mjs; the benchmark has no verdict of its own, because B3 judges the growth against the same bound.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { b3Target, withB3Out } from "./cases/b3-run.mjs";
import { B3_MEASUREMENTS } from "./measurements.mjs";
import { assertSplitLoadWithinBound, hostGrowthKb, restoreStress, runStressRounds, SPLIT_LOAD_GROWTH_BOUND_KB, SPLIT_LOAD_ROUNDS,
  splitLoadB3Values, startStress } from "./cases/split-load.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: split, resize, reload, and WebView churn cost less than ${SPLIT_LOAD_GROWTH_BOUND_KB} KB of host RSS growth`,
    { timeout: 600000 }, async (t) => {
      const session = await open(t, app);
      await withB3Out(b3Target(process.env, B3_MEASUREMENTS["split-load"]), async (run) => {
        const ctx = await startStress(session, app);
        run.conditions = ctx.conditions;
        session.cleanup(() => restoreStress(session, ctx));
        await runStressRounds(ctx, SPLIT_LOAD_ROUNDS);
        const growth = hostGrowthKb(ctx.samples);
        Object.assign(run.measurements, splitLoadB3Values(ctx.samples));
        t.diagnostic(`${app.name}: rounds ${SPLIT_LOAD_ROUNDS}; host RSS samples ${ctx.samples.join(" ")} KB; growth ${growth} KB; phases ${ctx.phases.length}`);
        assertSplitLoadWithinBound(growth);
      });
    });
}
