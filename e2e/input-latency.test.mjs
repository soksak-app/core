// The time from a key injected through the native input of the endpoint to its arrival in the document of the input probe, for the
// text field of its view and the field of its native document region (INPUT_LATENCY_TARGETS), with the performance trace off, on
// and off again, and with the producer gate of every class at `info` (docs/spec/logging.md#limits, docs/spec/logging.md#policy).
// Enter does not pass through the input method, so it reaches the field in an application that is not active. The arrival is the
// time of the key down event in the document, which `probeinput.clock` maps to the clock of the check (clockOffset of
// input-latency.mjs). The numbers are measured, not asserted: the check requires only that every key arrives, and it prints the
// time of each key. B3 output (SOKSAK_B3_OUT, benchmark/cases/b3-run.mjs): fieldMedianMs, fieldP90Ms, documentMedianMs and
// documentP90Ms (inputLatencyB3Values of input-latency.mjs), the keys of input-latency in B3_MEASUREMENTS of
// benchmark/measurements.mjs, with the conditions of the first configuration with the trace off and the default gate; the check
// has no verdict.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { b3Conditions, b3Target, fixtureSettings, withB3Out } from "./benchmark/cases/b3-run.mjs";
import { B3_MEASUREMENTS, B3_SETTINGS } from "./benchmark/measurements.mjs";
import { fresh } from "./fixture.mjs";
import { CONFIGURATIONS, INPUT_LATENCY_TARGETS, clockOffset, inputLatencyB3Values, keyFigures, keyLatency } from "./input-latency.mjs";
import { documentFocused, documentPoint, fieldPoint, inputProbeTab } from "./input-probe.mjs";

const KEYS = 12;
/** The samples of `probeinput.clock` that bound the offset of the clock of the document. */
const CLOCK_SAMPLES = 8;

/** The epoch time of the check in ms. */
const now = () => performance.timeOrigin + performance.now();

/** The status of the field of `target`. */
const statusOf = (target) => (target === "field" ? "probeinput.field" : "probeinput.document");

/** Gives the keyboard to the field of `target` of the probe `surface` with a press, and waits until it holds it. */
async function focusTarget(s, surface, target) {
  const point = target === "field" ? await fieldPoint(s, surface) : await documentPoint(s, surface);
  await s.click(point.x, point.y);
  await s.until("host.window", (state) => (target === "field" ? state.responder?.surface === surface : documentFocused(state, surface)),
    `the ${target} of ${surface} did not take the keyboard after the press`);
  await s.until(statusOf(target), (state) => state.focused, `the ${target} of ${surface} did not report its focus`, { surface });
}

/** The offset of the clock of the document of `target` (clockOffset). */
async function documentClock(s, surface, target) {
  const samples = [];
  for (let index = 0; index < CLOCK_SAMPLES; index += 1) {
    const sentMs = now();
    const clock = await s.run("probeinput.clock", { target }, surface);
    samples.push({ sentMs, receivedMs: now(), clock });
  }
  return clockOffset(samples);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: input latency from the injected key to its arrival, trace off and on and the gate at info, in a view field and a document region`,
    { timeout: 160000 * INPUT_LATENCY_TARGETS.length }, async (t) => {
      const s = await open(t, app);
      await withB3Out(b3Target(process.env, B3_MEASUREMENTS["input-latency"]), async (run) => {
        for (const target of INPUT_LATENCY_TARGETS) {
          const results = [];
          for (const { trace, gate } of CONFIGURATIONS) {
            // The B3 values are those of the configurations with the trace off and the default gate, which apply the settings of
            // B3_SETTINGS and assert them.
            const b3 = !trace && gate === undefined;
            await fresh(s, b3 ? fixtureSettings(B3_SETTINGS["input-latency"]) : { performanceTrace: trace, log: gate });
            if (b3) {
              const conditions = await b3Conditions(s, B3_SETTINGS["input-latency"]);
              run.conditions ??= conditions;
            }
            const { surface } = await inputProbeTab(s);
            await focusTarget(s, surface, target);
            const { offsetMs, errorMs } = await documentClock(s, surface, target);
            const samples = [];
            const sizesBefore = currentEventOffsets(s.app.configDir);
            const typingStarted = performance.now();
            for (let key = 1; key <= KEYS; key += 1) {
              const before = (await s.get(statusOf(target), surface)).keys.at(-1)?.sequence ?? 0;
              const startedMs = now();
              await s.key("Enter", "down");
              await s.key("Enter", "up");
              const state = await s.until(statusOf(target), (value) => value.keys.some((entry) => entry.sequence > before
                && entry.type === "keydown" && entry.key === "Enter"), `Enter number ${key} did not arrive in the ${target} of ${surface}`,
              { surface });
              const arrived = state.keys.find((entry) => entry.sequence > before && entry.type === "keydown" && entry.key === "Enter");
              const latency = keyLatency({ startedMs, atMs: arrived.atMs, documentTimeOriginMs: state.documentTimeOriginMs, offsetMs });
              assert.ok(latency + errorMs >= 0,
                `Enter number ${key} arrived ${-latency} ms before it was sent, beyond the clock bound ${errorMs} ms`);
              samples.push(latency);
            }
            // The bytes per minute that each event file of the configuration gained while the keys were typed.
            const minutes = (performance.now() - typingStarted) / 60000;
            const sizesAfter = currentEventOffsets(s.app.configDir);
            const bytesPerMinute = Object.fromEntries(Object.entries(sizesAfter)
              .filter(([name, after]) => sizesBefore[name]?.inode === after.inode && after.offset > sizesBefore[name].offset)
              .map(([name, after]) => [name.replace(/^(\w+)-\d+-\d+/, "$1"), Math.round((after.offset - sizesBefore[name].offset) / minutes)]));
            results.push({ target, trace, gate: gate === undefined ? "default" : "info", clockErrorMs: Number(errorMs.toFixed(2)),
              ...keyFigures(samples), bytesPerMinute });
          }
          Object.assign(run.measurements, inputLatencyB3Values(target, results));
          t.diagnostic(`${app.name} ${target} input latency ${JSON.stringify(results)}`);
          console.log(`${app.name} ${target} input latency ${JSON.stringify(results)}`);
        }
      });
    });
}
