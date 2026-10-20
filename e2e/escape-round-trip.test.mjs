// Measures the Escape round trip of the native modal menu: the time from the receipt of the overlay answer on the main page
// (page.trace.modal.answer, key core.modal.dismiss) to the close of the picker (page.trace.picker.close, reason dismiss). Both
// events carry the monotonic clock mono_ns of the event contract, and the difference of the two clocks is the round trip. The
// check reports the median of the runs of each host (docs/spec/performance-trace.md#producers).
import assert from "node:assert/strict";
import { loadavg } from "node:os";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { fresh, reading } from "./fixture.mjs";

const RUNS = 5;
// The limit of one round trip: from the Escape press until the close record is in the event log.
const ROUND_TIMEOUT = 30000;
// The limit of the runs of one host, which covers the menu opens and their closes.
const HOST_TIMEOUT = 300000;
const ANSWER = "page.trace.modal.answer";
const CLOSE = "page.trace.picker.close";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const loads = () => loadavg().map((value) => value.toFixed(2)).join(" ");

/**
 * Closes the add menu when a round failed before its close, so the next round starts from a closed menu. A menu that is
 * already closed needs no command.
 */
async function closePicker(s) {
  const picker = await s.get("core.picker");
  if (!picker.open) return;
  await s.run("core.picker.close");
  await s.until("core.picker", (value) => !value.open, "the add menu did not close in the cleanup of a failed round");
}

/**
 * Opens the add menu of the card, sends Escape through native input, and returns the nanoseconds from the receipt of the
 * answer on the main page to the close of the picker. The events are read after the offsets taken before the Escape, so
 * only the records of this round trip are in the read.
 */
async function roundTripNs(s, app, card) {
  await s.run("core.card.menu", { card, menu: "add" });
  await s.until("core.picker", (value) => value.open, "the add menu of the card did not open");
  // The menu is a native modal: its window is shown and its document is rendered before Escape reaches the overlay.
  await s.until("host.window", (w) => w.modal?.id === "picker" && w.modal.shown, "the add menu did not show its native modal");
  await s.until("core.modal", (modal) => modal?.id === "picker" && modal.document !== null, "the add menu did not render");
  const before = currentEventOffsets(app.configDir);
  await s.press("Escape");
  await s.until("core.picker", (value) => !value.open, "the add menu did not close after Escape");
  await s.flushLog();
  await untilEventLines(app.configDir, before,
    (lines) => lines.some((line) => line.includes(`${CLOSE}: `) && line.includes('"reason":"dismiss"')),
    ROUND_TIMEOUT, reading(app, [ANSWER, CLOSE]));
  const { events } = readEvents(app.configDir, before);
  const rows = traceRows(events);
  const answers = rows.filter((row) => row.event === "modal.answer" && row.key === "core.modal.dismiss");
  const closes = rows.filter((row) => row.event === "picker.close" && row.reason === "dismiss");
  if (answers.length !== 1) throw new Error(`expected one modal.answer for core.modal.dismiss, found ${answers.length}`);
  if (closes.length !== 1) throw new Error(`expected one picker.close with reason dismiss, found ${closes.length}`);
  // traceRows keeps the wall clock of a row and drops mono_ns, so the monotonic clock is read from the same events.
  const answer = events.find((event) => event.event === ANSWER && event.fields?.key === "core.modal.dismiss");
  const close = events.find((event) => event.event === CLOSE && event.fields?.reason === "dismiss");
  for (const [name, event] of [["modal.answer", answer], ["picker.close", close]]) {
    if (!Number.isInteger(event.mono_ns) || event.mono_ns <= 0) throw new Error(`${name} has no positive mono_ns: ${event.mono_ns}`);
  }
  const ns = close.mono_ns - answer.mono_ns;
  if (ns < 0) throw new Error(`picker.close (${close.mono_ns}) precedes modal.answer (${answer.mono_ns})`);
  return ns;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the Escape round trip of the native modal menu`, { timeout: HOST_TIMEOUT + 60000 }, async (t) => {
    const s = await open(t, app);
    t.diagnostic(`load average at start ${loads()}`);
    await fresh(s, { performanceTrace: true, reads: [ANSWER, CLOSE] });
    const card = (await s.get("core.grid")).cards.find((item) => item.pane !== null && item.acts?.add?.enabled);
    if (!card) throw new Error(`${app.name}: no pane card has an enabled add menu`);
    const values = [];
    for (let run = 1; run <= RUNS; run++) {
      await t.test(`${app.name}: round trip ${run} of ${RUNS}`, { timeout: ROUND_TIMEOUT + 30000 }, async (u) => {
        let ns;
        try {
          ns = await roundTripNs(s, app, card.id);
        } catch (error) {
          // The failure of this round is rethrown. A cleanup failure is reported with it, so neither error is dropped.
          await closePicker(s).catch((cleanup) => u.diagnostic(`cleanup after round ${run} failed: ${cleanup.message}`));
          throw error;
        }
        values.push(ns / 1e6);
        u.diagnostic(`${app.name} round trip ${run}: ${(ns / 1e6).toFixed(3)} ms`);
      });
    }
    assert.equal(values.length, RUNS, `${app.name}: ${values.length} of ${RUNS} round trips were measured`);
    t.diagnostic(`load average at end ${loads()}`);
    t.diagnostic(`${app.name} escape round trip median: ${median(values).toFixed(3)} ms of ${values.map((ms) => ms.toFixed(3)).join(", ")}`);
  });
}
