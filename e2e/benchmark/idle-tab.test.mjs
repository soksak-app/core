// Measures the cost of an idle browser tab on a blank page and judges it against IDLE_TAB_BOUND_KB (cases/idle-tab.mjs). The window check
// e2e/idle-tab-memory.test.mjs runs the same tab and judges only the behaviour.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { assertIdleTabWithinBound, recordIdleTab } from "./cases/idle-tab.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an idle browser tab on a blank page costs at most 50 MB`, { timeout: 300000 }, async (t) => {
    const s = await open(t, app);
    const measurement = await recordIdleTab(s);
    t.diagnostic(`${app.name}: documents ${measurement.settled} KB; main web view ${measurement.mainBefore} -> ` +
      `${measurement.mainAfter} KB (${measurement.growth} KB); cost ${measurement.cost} KB`);
    assertIdleTabWithinBound(measurement);
  });
}
