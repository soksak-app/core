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

/**
 * The time (ms) and the captured frames from the end of the gesture to the first frame from which the measured edge stays
 * within 2 points of its final position, and that position.
 */
export function cardEdgeConvergence(samples, gestureEndedAtMs) {
  const ended = samples.findIndex(({ time }) => time >= gestureEndedAtMs);
  if (ended < 0) {
    throw new Error(`no measured frame at or after the gesture end ${gestureEndedAtMs}; the last frame is at ${samples.at(-1)?.time}`);
  }
  const finalPosition = samples.at(-1).position;
  let settled = samples.length - 1;
  while (settled > ended && Math.abs(samples[settled - 1].position - finalPosition) <= 2) settled -= 1;
  return { ms: samples[settled].time - gestureEndedAtMs, frames: settled - ended, finalPosition };
}
