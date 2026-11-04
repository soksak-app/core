// The summary of the plain view benchmark (plain-view.test.mjs).
import assert from "node:assert/strict";

/** The count and the median, p90 and largest interval (ms) between the source frames whose time range meets the gesture. */
export function sourceIntervalSummary(sourceFrames, gestureStartedAtMs, gestureEndedAtMs) {
  assert.ok(Array.isArray(sourceFrames), "source frames must be an array");
  const inGesture = sourceFrames.filter(({ timeRange }) => timeRange.upperMs >= gestureStartedAtMs && timeRange.lowerMs <= gestureEndedAtMs);
  const intervals = inGesture.slice(1).map((frame, index) => frame.frameTimeMs - inGesture[index].frameTimeMs).sort((a, b) => a - b);
  if (intervals.length === 0) return { count: inGesture.length, medianMs: null, p90Ms: null, maxMs: null };
  return {
    count: inGesture.length,
    medianMs: intervals[Math.floor(intervals.length / 2)],
    p90Ms: intervals[Math.floor(intervals.length * 0.9)],
    maxMs: intervals.at(-1),
  };
}

/** The times and the positions (points) of the frames whose moved card edge measure reads, and the indexes of the other frames. */
export function cardEdgeSamples(frames, measure) {
  const samples = [];
  const unmeasured = [];
  frames.forEach((frame, index) => {
    const position = measure(frame);
    if (position === null) unmeasured.push(index);
    else samples.push({ time: frame.time, position });
  });
  return { samples, unmeasured };
}
