import assert from "node:assert/strict";
import test from "node:test";

import { displayRefreshes, readDisplayRefreshes, refreshAfter } from "../display-refresh.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const observation = (timestamp, duration) => ({ timestamp, targetTimestamp: timestamp + duration, duration, displayID: 1, windowNumber: 2, visible: true, occluded: false, sequence: 0 });

test("display refreshes are the observed refreshes in milliseconds", { timeout: 1000 }, () => {
  const link = { state: "available", reason: null, omittedObservations: 0, observations: [observation(1.5, 1 / 60), observation(1.5 + 1 / 60, 1 / 60)] };
  assert.deepEqual(displayRefreshes(link).times.map((time) => Math.round(time * 1000) / 1000), [1500, 1516.667]);
  assert.deepEqual(displayRefreshes(link).periods.map((period) => Math.round(period * 1000) / 1000), [16.667, 16.667]);
});

test("display refreshes reject a recording that omitted observations", { timeout: 1000 }, () => {
  const link = { state: "available", reason: null, omittedObservations: 3, observations: [observation(1, 1 / 60)] };
  assert.throws(() => displayRefreshes(link), /omitted 3 observations/);
});

test("display refreshes reject missing observations and invalid timestamps", { timeout: 1000 }, () => {
  assert.throws(() => displayRefreshes({ state: "available", omittedObservations: 0 }), /observations array/);
  assert.throws(() => displayRefreshes({ state: "available", omittedObservations: 0, observations: [{ timestamp: NaN, duration: 1 / 60 }] }), /no timestamp/);
  assert.throws(() => displayRefreshes({ state: "available", omittedObservations: 0, observations: [{ timestamp: 1, duration: 0 }] }), /no display period/);
});

test("the window end is the count-th observed refresh after a time", { timeout: 1000 }, () => {
  const times = [0, 10, 20, 30];
  assert.equal(refreshAfter(times, 5, 1), 10);
  assert.equal(refreshAfter(times, 5, 2), 20);
  assert.throws(() => refreshAfter(times, 25, 2), /2 needed/);
});

test("display refreshes reject a recording whose display link is not available", { timeout: 1000 }, () => {
  const link = { state: "unavailable", reason: "the window is hidden", omittedObservations: 0, observations: [observation(1, 1 / 60)] };
  assert.throws(() => displayRefreshes(link), /display link is unavailable: the window is hidden/);
  assert.throws(() => displayRefreshes({ ...link, state: undefined }), /display link is undefined/);
});

test("a recording's refresh times are read from its display-link.json", { timeout: 1000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "display-refresh-"));
  try {
    writeFileSync(join(directory, "display-link.json"), JSON.stringify({ state: "available", reason: "", omittedObservations: 0,
      observations: [observation(2, 1 / 120), observation(2.5, 1 / 60)] }));
    assert.deepEqual(readDisplayRefreshes(directory).times, [2000, 2500]);
    writeFileSync(join(directory, "display-link.json"), JSON.stringify({ state: "unavailable", reason: "hidden", omittedObservations: 0, observations: [] }));
    assert.throws(() => readDisplayRefreshes(directory), /display link is unavailable: hidden/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
