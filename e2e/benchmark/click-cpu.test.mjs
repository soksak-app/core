// Measures the CPU cost of CLICKS native clicks on a grid of two rows of five raster probe cards and the time from each press to the
// focus of its card (cases/click-cpu.mjs, docs/operations/examples.md#click-cpu-benchmark). It reports the figures and judges none:
// no performance goal states a bound for them.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { CLICKS, runClicks } from "./cases/click-cpu.mjs";
import { cpuLine } from "./cases/process-cpu.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: ${CLICKS} clicks on ten image region cards report their CPU and press-to-focus times`, { timeout: 600000 }, async (t) => {
    const s = await open(t, app);
    const { cards, cpu, focus } = await runClicks(s);
    t.diagnostic(`${app.name}: ${cards} cards; CPU ${cpuLine(cpu)}`);
    t.diagnostic(`${app.name}: press to focus median ${focus.medianMs.toFixed(1)} ms, p90 ${focus.p90Ms.toFixed(1)} ms, ` +
      `max ${focus.maxMs.toFixed(1)} ms over ${focus.count} clicks`);
  });
}
