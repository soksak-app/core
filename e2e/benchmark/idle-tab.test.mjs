// Measures the cost of an idle layout probe tab with a document region and judges it against IDLE_TAB_BOUND_KB of the performance goals
// (cases/idle-tab.mjs). The window check e2e/idle-tab-memory.test.mjs runs the same tab and judges only the behaviour.
// B3 output (SOKSAK_B3_OUT, cases/b3-run.mjs): idleTabCostKb and documentPartKb (idleTabB3Values), the keys of idle-tab in
// B3_MEASUREMENTS of measurements.mjs; the benchmark has no verdict of its own, because B3 judges the cost against the same bound.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { b3Target, withB3Out } from "./cases/b3-run.mjs";
import { assertIdleTabWithinBound, IDLE_TAB_BOUND_KB, idleTabB3Values, recordIdleTab } from "./cases/idle-tab.mjs";
import { B3_MEASUREMENTS } from "./measurements.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an idle tab with a document region costs at most ${IDLE_TAB_BOUND_KB} KB`, { timeout: 300000 }, async (t) => {
    const s = await open(t, app);
    await withB3Out(b3Target(process.env, B3_MEASUREMENTS["idle-tab"]), async (run) => {
      const measurement = await recordIdleTab(s);
      run.conditions = measurement.conditions;
      Object.assign(run.measurements, idleTabB3Values(measurement));
      t.diagnostic(`${app.name}: documents ${measurement.settled} KB; ${measurement.growthOf} ${measurement.growthBefore} -> ` +
        `${measurement.growthAfter} KB (${measurement.growth} KB); cost ${measurement.cost} KB`);
      assertIdleTabWithinBound(measurement);
    });
  });
}
