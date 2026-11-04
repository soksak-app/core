// The view benchmark of the terminal view (runTerminalViewBenchmark of cases/terminal.mjs). B3 output (SOKSAK_B3_OUT): the keys of
// terminal-view in B3_MEASUREMENTS of measurements.mjs.
import test from "node:test";

import { APPS } from "@soksak/window-check/app.mjs";
import { runTerminalViewBenchmark } from "./cases/terminal.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: terminal view process and frame measurements meet the declared contract`, { timeout: 180000 },
    (t) => runTerminalViewBenchmark(t, app, "terminal", { wailsv3: 17, tauriv2: 23 }));
}
