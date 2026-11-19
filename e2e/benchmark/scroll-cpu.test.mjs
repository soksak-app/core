// Measures the CPU cost of scrolling a raster probe card that retains HISTORY lines from the newest line to the oldest and back with
// native wheels of STEP_LINES lines (cases/scroll-cpu.mjs, docs/operations/examples.md#scroll-cpu-benchmark). It reports the figures
// and judges none: no performance goal states a bound for them.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { cpuLine } from "./cases/process-cpu.mjs";
import { HISTORY, runScroll, STEP_LINES } from "./cases/scroll-cpu.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: scrolling ${HISTORY} retained lines in wheels of ${STEP_LINES} lines reports its CPU`, { timeout: 600000 }, async (t) => {
    const s = await open(t, app);
    const { wheels, deltaY, cpu, wheel } = await runScroll(s);
    t.diagnostic(`${app.name}: ${wheels} wheels of deltaY ${deltaY}; CPU ${cpuLine(cpu)}`);
    t.diagnostic(`${app.name}: wheel to presented frame median ${wheel.medianMs.toFixed(1)} ms, p90 ${wheel.p90Ms.toFixed(1)} ms, ` +
      `max ${wheel.maxMs.toFixed(1)} ms`);
  });
}
