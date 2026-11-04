// The time from a key injected through the native input of the endpoint to the prompt that the shell prints after the
// key reached the PTY, in a tab of each plugin of INPUT_LATENCY_PLUGINS (`terminal` and `term`), with the performance trace off,
// on and off again, and with the producer gate of every class at `info` (docs/spec/logging.md#limits,
// docs/spec/logging.md#policy). Enter does not pass through the input method, so it reaches the sidecar in an application that
// is not active. The numbers are measured, not asserted: the check requires only that every key is answered, and it prints the
// time of each key. B3 output (SOKSAK_B3_OUT, benchmark/cases/b3-run.mjs): terminalMedianMs, terminalP90Ms, termMedianMs and
// termP90Ms (inputLatencyB3Values of input-latency.mjs), the keys of input-latency in B3_MEASUREMENTS of benchmark/measurements.mjs,
// with the conditions of the first configuration with the trace off and the default gate; the check has no verdict.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { b3Conditions, b3Target, fixtureSettings, withB3Out } from "./benchmark/cases/b3-run.mjs";
import { B3_MEASUREMENTS, B3_SETTINGS } from "./benchmark/measurements.mjs";
import { fresh } from "./fixture.mjs";
import { readTabScreenUntil, terminalShellSettings } from "./benchmark/cases/terminal.mjs";
import { CONFIGURATIONS, INPUT_LATENCY_PLUGINS, inputLatencyB3Values, keyFigures } from "./input-latency.mjs";

const KEYS = 12;
const promptCount = (lines) => lines.filter((line) => line.startsWith("sh-")).length;

/**
 * The tab of `plugin` that the configuration measures: the active tab of the card of the fixture terminal when it is a tab of the
 * plugin, otherwise a new tab of the plugin in a split of that card. Waits until its session runs and its shell printed a prompt.
 */
async function pluginTab(s, plugin, terminal) {
  let surface = terminal.surface;
  if (plugin !== "terminal") {
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.tabs.some((tab) => tab.id === terminal.surface));
    assert.ok(card, `the fixture terminal ${terminal.surface} is in no card`);
    ({ tab: surface } = await s.run("core.card.split", { card: card.id, side: "right", plugin }));
  }
  await s.until(`${plugin}.session`, (state) => Boolean(state?.sessionId), `${surface} did not open a sidecar session`, { surface });
  return surface;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: input latency from the injected key to the prompt, trace off and on and the gate at info, in a terminal and a term tab`,
    { timeout: 160000 * INPUT_LATENCY_PLUGINS.length }, async (t) => {
      const s = await open(t, app);
      await withB3Out(b3Target(process.env, B3_MEASUREMENTS["input-latency"]), async (run) => {
        for (const plugin of INPUT_LATENCY_PLUGINS) {
          const results = [];
          for (const { trace, gate } of CONFIGURATIONS) {
            // The B3 values are those of the configurations with the trace off and the default gate, which apply the settings of
            // B3_SETTINGS and assert them.
            const b3 = !trace && gate === undefined;
            const terminal = await fresh(s, { ...(b3 ? fixtureSettings(B3_SETTINGS["input-latency"]) : { performanceTrace: trace, log: gate }),
              settings: terminalShellSettings(plugin) });
            if (b3) {
              const conditions = await b3Conditions(s, B3_SETTINGS["input-latency"]);
              run.conditions ??= conditions;
            }
            const surface = await pluginTab(s, plugin, terminal);
            let lines = await readTabScreenUntil(s, plugin, surface, (rows) => promptCount(rows) >= 1, `${surface} printed no prompt`);
            const rows = (await s.get(`${plugin}.screen`, surface)).length;
            assert.ok(rows >= KEYS + 4, `the screen of ${surface} has ${rows} rows; ${KEYS} prompts would scroll the count away`);
            const host = await s.get("host.window");
            const region = host.regions.find((item) => item.surface === surface && item.name === "view");
            assert.ok(region?.frame, `native ${plugin} region ${surface} has no frame`);
            await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height / 2);
            await s.until("host.window", (state) => state.regions.some((item) =>
              item.surface === surface && item.name === "view" && item.focused),
            `the ${plugin} region ${surface} did not take the keyboard after the press`);
            const samples = [];
            const sizesBefore = currentEventOffsets(s.app.configDir);
            const typingStarted = performance.now();
            for (let key = 1; key <= KEYS; key += 1) {
              const before = promptCount(lines);
              const started = performance.now();
              await s.key("Enter", "down");
              await s.key("Enter", "up");
              lines = await readTabScreenUntil(s, plugin, surface, (rowsNow) => promptCount(rowsNow) > before,
                `no prompt followed Enter number ${key} in ${surface}`);
              samples.push(performance.now() - started);
            }
            // The bytes per minute that each event file of the configuration gained while the keys were typed.
            const minutes = (performance.now() - typingStarted) / 60000;
            const sizesAfter = currentEventOffsets(s.app.configDir);
            const bytesPerMinute = Object.fromEntries(Object.entries(sizesAfter)
              .filter(([name, after]) => sizesBefore[name]?.inode === after.inode && after.offset > sizesBefore[name].offset)
              .map(([name, after]) => [name.replace(/^(\w+)-\d+-\d+/, "$1"), Math.round((after.offset - sizesBefore[name].offset) / minutes)]));
            results.push({ plugin, trace, gate: gate === undefined ? "default" : "info", ...keyFigures(samples), bytesPerMinute });
          }
          Object.assign(run.measurements, inputLatencyB3Values(plugin, results));
          t.diagnostic(`${app.name} ${plugin} input latency ${JSON.stringify(results)}`);
          console.log(`${app.name} ${plugin} input latency ${JSON.stringify(results)}`);
        }
      });
    });
}
