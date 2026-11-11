import assert from "node:assert/strict";
import test from "node:test";

import { displayPeriod, displayRefreshes, refreshAfter } from "../display-refresh.mjs";

const observation = (timestamp, duration) => ({ timestamp, targetTimestamp: timestamp + duration, duration, displayID: 1, windowNumber: 2, visible: true, occluded: false, sequence: 0 });

test("display refreshes are the observed refreshes in milliseconds", { timeout: 1000 }, () => {
  const link = { state: "recorded", reason: null, omittedObservations: 0, observations: [observation(1.5, 1 / 60), observation(1.5 + 1 / 60, 1 / 60)] };
  assert.deepEqual(displayRefreshes(link).times.map((time) => Math.round(time * 1000) / 1000), [1500, 1516.667]);
  assert.deepEqual(displayRefreshes(link).periods.map((period) => Math.round(period * 1000) / 1000), [16.667, 16.667]);
});

test("display refreshes reject a recording that omitted observations", { timeout: 1000 }, () => {
  const link = { state: "recorded", reason: null, omittedObservations: 3, observations: [observation(1, 1 / 60)] };
  assert.throws(() => displayRefreshes(link), /omitted 3 observations/);
});

test("display refreshes reject missing observations and invalid timestamps", { timeout: 1000 }, () => {
  assert.throws(() => displayRefreshes({ omittedObservations: 0 }), /observations array/);
  assert.throws(() => displayRefreshes({ omittedObservations: 0, observations: [{ timestamp: NaN, duration: 1 / 60 }] }), /no timestamp/);
  assert.throws(() => displayRefreshes({ omittedObservations: 0, observations: [{ timestamp: 1, duration: 0 }] }), /no display period/);
});

test("the display period is the median of the observed refresh durations", { timeout: 1000 }, () => {
  const at = (duration) => ({ state: "recorded", reason: null, omittedObservations: 0, observations: [observation(0, duration)] });
  assert.ok(Math.abs(displayPeriod({ ...at(1 / 120), observations: [observation(0, 1 / 120), observation(0, 1 / 60), observation(0, 1 / 120)] }) - 1000 / 120) < 1e-9);
  assert.ok(Math.abs(displayPeriod(at(1 / 60)) - 1000 / 60) < 1e-9);
  assert.throws(() => displayPeriod({ omittedObservations: 0, observations: [] }), /no display refresh/);
});

test("the window end is the count-th observed refresh after a time", { timeout: 1000 }, () => {
  const times = [0, 10, 20, 30];
  assert.equal(refreshAfter(times, 5, 1), 10);
  assert.equal(refreshAfter(times, 5, 2), 20);
  assert.throws(() => refreshAfter(times, 25, 2), /2 needed/);
});
