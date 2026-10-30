// Measures the time in which the layout stays behind the window after a maximise and a restore, and judges it against the catch-up
// limit of the resize case (cases/resize.mjs). The window check e2e/resize.test.mjs keeps the same frames and judges only the behaviour.
import test from "node:test";

import { APPS, open, RECORDING } from "@soksak/window-check/app.mjs";
import { judgeFrames } from "../resize-frames.mjs";
import { assertCatchUpWithinBound, recordMaximiseAndRestore } from "./cases/resize.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising and restoring keep the layout at the window size within the catch-up limit`, RECORDING, async (t) => {
    const s = await open(t, app);
    const took = {};
    await recordMaximiseAndRestore(s, (gesture, recorded) => {
      took[gesture] = judgeFrames(recorded.measured).took;
      t.diagnostic(`${app.name} ${gesture}: the layout stayed behind the window for ${took[gesture].toFixed(0)}ms`);
    });
    for (const [gesture, ms] of Object.entries(took)) assertCatchUpWithinBound(ms, `${app.name} ${gesture}`);
  });
}
