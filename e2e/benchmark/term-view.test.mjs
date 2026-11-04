// The view benchmark of the term view (runTerminalViewBenchmark of cases/terminal.mjs). The term plugin has no recorded DOM mount
// baseline, so (iii) and (iii-b) judge it against the first-display margin alone. B3 output (SOKSAK_B3_OUT): the keys of
// term-view in B3_MEASUREMENTS of measurements.mjs.
import test from "node:test";

import { APPS } from "@soksak/window-check/app.mjs";
import { runTerminalViewBenchmark } from "./cases/terminal.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: term view process and frame measurements meet the declared contract`, { timeout: 180000 },
    (t) => runTerminalViewBenchmark(t, app, "term", null));
}
