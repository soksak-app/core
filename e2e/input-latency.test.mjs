// The time from a key injected through the native input of the endpoint to the prompt that the shell prints after the
// key reached the PTY, with the performance trace off, on and off again, and with the producer gate of every class at
// `info` (docs/spec/logging.md#limits, docs/spec/logging.md#policy). Enter does not
// pass through the input method, so it reaches the sidecar in an application that is not active. The numbers are
// measured, not asserted: the check requires only that every key is answered.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

const KEYS = 12;
const promptCount = (lines) => lines.filter((line) => line.startsWith("sh-")).length;
const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];

for (const app of Object.values(APPS)) {
  test(`${app.name}: input latency from the injected key to the prompt, trace off and on and the gate at info`, { timeout: 160000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    const results = [];
    const INFO = { lifecycle: "info", input: "info", call: "info", io: "info", frame: "info" };
    for (const { trace, gate } of [{ trace: false }, { trace: true }, { trace: false }, { trace: false, gate: INFO }]) {
      await fresh(s, { performanceTrace: trace, log: gate ?? {} });
      const [terminal] = await ensureTerminals(s, 1);
      await s.until("terminal.session", (state) => Boolean(state.sessionId),
        `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface });
      let lines = await readScreenUntil(s, terminal.surface, (rows) => promptCount(rows) >= 1, "the shell printed no prompt");
      const rows = (await s.get("terminal.screen", terminal.surface)).length;
      assert.ok(rows >= KEYS + 4, `the screen has ${rows} rows; ${KEYS} prompts would scroll the count away`);
      const host = await s.get("host.window");
      const region = host.regions.find((item) => item.surface === terminal.surface && item.name === "view");
      assert.ok(region?.frame, `native terminal region ${terminal.surface} has no frame`);
      await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height / 2);
      await s.until("host.window", (state) => state.regions.some((item) =>
        item.surface === terminal.surface && item.name === "view" && item.focused),
      `the terminal region ${terminal.surface} did not take the keyboard after the press`);
      const samples = [];
      const sizesBefore = currentEventOffsets(s.app.configDir);
      const typingStarted = performance.now();
      for (let key = 1; key <= KEYS; key += 1) {
        const before = promptCount(lines);
        const started = performance.now();
        await s.key("Enter", "down");
        await s.key("Enter", "up");
        lines = await readScreenUntil(s, terminal.surface, (rowsNow) => promptCount(rowsNow) > before,
          `no prompt followed Enter number ${key}`);
        samples.push(performance.now() - started);
      }
      // The bytes per minute that each event file of the configuration gained while the keys were typed.
      const minutes = (performance.now() - typingStarted) / 60000;
      const sizesAfter = currentEventOffsets(s.app.configDir);
      const bytesPerMinute = Object.fromEntries(Object.entries(sizesAfter)
        .filter(([name, after]) => sizesBefore[name]?.inode === after.inode && after.offset > sizesBefore[name].offset)
        .map(([name, after]) => [name.replace(/^(\w+)-\d+-\d+/, "$1"), Math.round((after.offset - sizesBefore[name].offset) / minutes)]));
      const sorted = [...samples].sort((a, b) => a - b);
      results.push({ trace, gate: gate === undefined ? "trace" : "info", median_ms: Number(percentile(sorted, 0.5).toFixed(1)), p90_ms: Number(percentile(sorted, 0.9).toFixed(1)),
        max_ms: Number(sorted.at(-1).toFixed(1)), bytesPerMinute });
    }
    t.diagnostic(`${app.name} input latency ${JSON.stringify(results)}`);
    console.log(`${app.name} input latency ${JSON.stringify(results)}`);
  });
}
