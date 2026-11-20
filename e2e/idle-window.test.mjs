// An idle window does no work (docs/spec/debug.md#files): with no input and no change of state, over IDLE_REFRESHES refreshes that
// the display of the window delivered, the application writes no record, so the window runs no frame step (`host.frame.step`, which
// the mygo host records for each step of its main thread) and draws no frame (`host.frame.record`), and the notices of the event log
// reach no window, whose view does not follow the files. The refreshes are those of the display-link trace of a recording, and the
// span is judged by the refreshes delivered, not by a time: a span with fewer delivered refreshes fails with their number. The span
// is placed on the host event clock by measurement (alignClocks of @soksak/window-check/idle-window.mjs). The check gives no input,
// so it uses neither the pointer nor the focus of a person and does not depend on the frontmost application.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { alignClocks, clockNanoseconds, idleSpan } from "@soksak/window-check/idle-window.mjs";
import { fresh } from "./fixture.mjs";

/** The refreshes that the display delivers in the idle span. */
const IDLE_REFRESHES = 120;
/** The policy of the check stores every class at the level debug, so a record of any work in the span is stored. */
const LOG = { lifecycle: "debug", input: "debug", call: "debug", io: "debug", frame: "debug" };
/**
 * The records that the check itself causes in the span. A record enters this list only when a run of the check shows that the check
 * caused it; none is shown yet, so the list is empty.
 */
const EXCLUSIONS = [];

const clock = async (s) => clockNanoseconds((await s.request("diagnostics.clock")).mono_ns, "diagnostics.clock mono_ns");

for (const app of Object.values(APPS)) {
  test(`${app.name}: an idle window writes no record over ${IDLE_REFRESHES} delivered display refreshes`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: LOG, measure: true, reads: ["host.frame.step", "host.frame.record"] });
    const window = await s.get("host.window");
    if (!(Number.isFinite(window.refreshRate) && window.refreshRate > 0)) {
      throw new Error(`host.window.refreshRate is ${JSON.stringify(window.refreshRate)}`);
    }
    // The recording plans twice the refreshes of the span at the rate of the display now; a display that delivers fewer fails the
    // count below, whatever its rate.
    const planMs = Math.ceil(2 * IDLE_REFRESHES * 1000 / window.refreshRate);
    const before = await clock(s);
    const recording = await s.record({ gap: 1000, seconds: Math.ceil(planMs / 1000) + 2 });
    assert.notEqual(recording.frames, null, "the recording did not start");
    const offsets = currentEventOffsets(app.configDir);
    const notices = (await s.get("host.log")).notices;
    const from = await clock(s);
    const to = from + BigInt(planMs) * 1_000_000n;
    // The stop waits on the host for the still at the end of the span, on the capture clock: the Mach clock in milliseconds.
    const stop = await recording.stop({ after: Number(to) / 1e6 });
    assert.notEqual(stop, null, "the recording did not stop");
    const after = await clock(s);
    await s.flushLog();
    const { events } = readEvents(app.configDir, offsets);
    const { refreshes, skewNs } = alignClocks(JSON.parse(readFileSync(stop.displayLink, "utf8")), { before, after });
    const span = idleSpan({ refreshes, events, from, to, exclusions: EXCLUSIONS });
    const published = (await s.get("host.log")).notices - notices;
    t.diagnostic(`${app.name}: ${span.refreshes} refreshes in ${planMs} ms at ${window.refreshRate} Hz, clock skew ${skewNs} ns, ` +
      `frame steps ${window.frames === null ? "not recorded by this host" : "recorded"}, ${published} notices published from the ` +
      `start to the end of the measurement, work ${JSON.stringify(span.work)}, excluded ${JSON.stringify(span.excluded)}`);
    assert.ok(span.refreshes >= IDLE_REFRESHES,
      `the display delivered ${span.refreshes} refreshes in the span, fewer than the ${IDLE_REFRESHES} the check judges`);
    assert.deepEqual(span.work, {}, `${app.name} wrote records in an idle span of ${span.refreshes} refreshes`);
  });
}
