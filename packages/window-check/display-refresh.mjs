import assert from "node:assert/strict";

/**
 * Reads the display refreshes that actually occurred for a window from a recording's display-link.json.
 * Times are milliseconds on the frame clock and periods are the display period of each refresh, so a window
 * that moves between displays keeps the rate of the display it was on at each refresh.
 */
export function displayRefreshes(link) {
  assert.ok(link?.state === "available", `display link is ${link?.state}: ${link?.reason}`);
  assert.ok(Array.isArray(link?.observations), "display-link.json has no observations array");
  assert.ok(link.omittedObservations === 0,
    `display-link.json omitted ${link.omittedObservations} observations`);
  const times = [];
  const periods = [];
  for (const observation of link.observations) {
    assert.ok(Number.isFinite(observation.timestamp), "display observation has no timestamp");
    assert.ok(Number.isFinite(observation.duration) && observation.duration > 0,
      "display observation has no display period");
    times.push(observation.timestamp * 1000);
    periods.push(observation.duration * 1000);
  }
  return { times, periods };
}

/** The median display period (ms) of the observed refreshes of a recording. */
export function displayPeriod(link) {
  const { periods } = displayRefreshes(link);
  assert.ok(periods.length > 0, "the recording has no display refresh");
  const sorted = [...periods].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The time of the count-th observed refresh strictly after a time. times must be ascending. */
export function refreshAfter(times, time, count) {
  const first = times.findIndex((refresh) => refresh > time);
  assert.ok(first >= 0 && first + count - 1 < times.length,
    `only ${first < 0 ? 0 : times.length - first} refreshes after ${time}ms; ${count} needed`);
  return times[first + count - 1];
}
