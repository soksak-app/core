import assert from "node:assert/strict";
import test from "node:test";

import { alignClocks, clockNanoseconds, idleSpan } from "../idle-window.mjs";

// A Mach timebase of 125/3, as on Apple silicon: one tick is 41.67 ns.
const NUMERATOR = 125, DENOMINATOR = 3;
const ticks = (ns) => String(ns * BigInt(DENOMINATOR) / BigInt(NUMERATOR));

/** A display-link observation of a refresh at `refresh` ns whose callback runs `lag` ns later, with the period `period` ns. */
const observation = (refresh, lag, period, mediaSkew = 0n) => ({
  timestamp: Number(refresh) / 1e9, targetTimestamp: Number(refresh + period) / 1e9, duration: Number(period) / 1e9,
  callbackTime: ticks(refresh + lag), callbackMediaTime: Number(refresh + lag + mediaSkew) / 1e9,
  mediaClockAfter: ticks(refresh + lag), machTimebaseNumerator: NUMERATOR, machTimebaseDenominator: DENOMINATOR,
});
const PERIOD = 8_333_333n;
const START = 5_000_000_000_000n;
const link = (observations) => ({ state: "available", reason: "", omittedObservations: 0, observations });
const trace = (count, period = PERIOD) => link(Array.from({ length: count }, (_, i) => observation(START + BigInt(i) * period, 500_000n, period)));

test("the refreshes of a display link are on the host event clock between the clock reads of the recording", { timeout: 1000 }, () => {
  const { refreshes, skewNs } = alignClocks(trace(3), { before: START, after: START + 3n * PERIOD });
  assert.deepEqual(refreshes.map(({ ns }) => ns - START), [0n, PERIOD, 2n * PERIOD].map((ns) => ns));
  assert.ok(refreshes.every(({ periodNs }) => periodNs === PERIOD));
  assert.ok(skewNs < 1000n, `skew ${skewNs} ns`);
});

test("a callback outside the clock reads of the recording is an error", { timeout: 1000 }, () => {
  assert.throws(() => alignClocks(trace(3), { before: START + PERIOD, after: START + 3n * PERIOD }),
    /display-link observation 1 has its callback at \d+ ns, outside the clock reads/);
});

test("a media clock that is a display period away from the Mach clock is an error", { timeout: 1000 }, () => {
  assert.throws(() => alignClocks(link([observation(START, 500_000n, PERIOD, PERIOD)]), { before: START, after: START + PERIOD }),
    /not within its display period of 8333333 ns/);
});

test("a display link that is not available or omitted observations is an error", { timeout: 1000 }, () => {
  assert.throws(() => alignClocks({ state: "unavailable", reason: "the window is hidden" }, { before: 1n, after: 2n }),
    /the display link is unavailable: the window is hidden/);
  assert.throws(() => alignClocks({ ...trace(1), omittedObservations: 2 }, { before: START, after: START + PERIOD }),
    /omitted 2 observations/);
});

test("a clock read of diagnostics.clock is positive decimal nanoseconds", { timeout: 1000 }, () => {
  assert.equal(clockNanoseconds("1234"), 1234n);
  assert.throws(() => clockNanoseconds("0"), /not positive nanoseconds/);
  assert.throws(() => clockNanoseconds(1234), /not positive nanoseconds/);
});

const event = (layer, name, at, fields = {}) => ({ layer, event: name, mono_ns: Number(at), seq: 1, fields });

test("an idle span counts the refreshes and the records inside it and leaves out the excluded records", { timeout: 1000 }, () => {
  const { refreshes } = alignClocks(trace(10), { before: START, after: START + 10n * PERIOD });
  const from = START + PERIOD / 2n, to = START + 6n * PERIOD;
  const events = [
    event("host", "host.frame.step", from - 1n, { callback: "before" }),
    event("host", "host.frame.step", from + 10n, { callback: "deliver" }),
    event("host", "host.frame.step", from + 20n, { callback: "deliver" }),
    event("native", "native.capture.lifecycle", from + 30n),
    event("host", "host.frame.record", to),
    event("host", "host.frame.step", to + 1n, { callback: "after" }),
  ];
  const exclusions = [{ name: "the recording", matches: (e) => e.event === "native.capture.lifecycle" }];
  assert.deepEqual(idleSpan({ refreshes, events, from, to, exclusions }), {
    refreshes: 6,
    work: { "host host.frame.step deliver": 2, "host host.frame.record": 1 },
    excluded: { "the recording": 1 },
  });
});

test("an idle span of no record has no work", { timeout: 1000 }, () => {
  const { refreshes } = alignClocks(trace(4), { before: START, after: START + 4n * PERIOD });
  assert.deepEqual(idleSpan({ refreshes, events: [], from: START, to: START + 3n * PERIOD }), { refreshes: 3, work: {}, excluded: {} });
});

test("an empty span or a record without mono_ns is an error", { timeout: 1000 }, () => {
  assert.throws(() => idleSpan({ refreshes: [], events: [], from: START, to: START }), /is empty/);
  assert.throws(() => idleSpan({ refreshes: [], events: [{ layer: "host", event: "host.frame.step", seq: 7 }], from: START, to: START + 1n }),
    /the host.frame.step record at seq 7 has mono_ns undefined/);
});
