import assert from "node:assert/strict";
import test from "node:test";

import { cardEdgeConvergence, cardEdgeSamples, sourceIntervalSummary } from "../benchmark/cases/plain-view.mjs";

const frame = (frameTimeMs) => ({ frameTimeMs, timeRange: { lowerMs: frameTimeMs, upperMs: frameTimeMs + 1 } });

test("the plain view summary reads only the source frames that meet the gesture", { timeout: 5000 }, () => {
  const frames = [frame(0), frame(100), frame(110), frame(130), frame(170), frame(500)];
  assert.deepEqual(sourceIntervalSummary(frames, 100, 170), { count: 4, medianMs: 20, p90Ms: 40, maxMs: 40 });
});

test("the plain view summary states no interval for a single source frame", { timeout: 5000 }, () => {
  assert.deepEqual(sourceIntervalSummary([frame(100)], 100, 170), { count: 1, medianMs: null, p90Ms: null, maxMs: null });
});

// A sample keeps the request time of its still as its time and the completion time of the still.
test("the plain view edge samples keep the measured frames and name the others", { timeout: 5000 }, () => {
  const frames = [{ requested: 1, completed: 1.5, edge: 100 }, { requested: 2, completed: 2.5, edge: null },
    { requested: 3, completed: 3.5, edge: 110 }];
  assert.deepEqual(cardEdgeSamples(frames, (frame) => frame.edge), {
    samples: [{ time: 1, completed: 1.5, position: 100 }, { time: 3, completed: 3.5, position: 110 }],
    unmeasured: [1],
  });
});

// The convergence starts at the first still requested at or after the end of the gesture, and the edge is at its final position
// no later than the completion of the still from which it stays there.
test("the plain view convergence is the first frame after the gesture from which the edge stays at its final position", { timeout: 5000 }, () => {
  const samples = [[90, 120], [100, 110], [110, 104], [120, 101], [130, 104], [140, 100], [150, 100]]
    .map(([time, position]) => ({ time, completed: time + 0.5, position }));
  assert.deepEqual(cardEdgeConvergence(samples, 105), { ms: 35.5, frames: 3, finalPosition: 100 },
    "a frame that left the final position again does not end the convergence");
  assert.deepEqual(cardEdgeConvergence(samples, 100), { ms: 40.5, frames: 4, finalPosition: 100 },
    "a still requested at the end of the gesture starts the convergence");
});

test("the plain view convergence states the frame at the end of the gesture as zero frames", { timeout: 5000 }, () => {
  const samples = [{ time: 100, completed: 100.5, position: 100 }, { time: 110, completed: 110.5, position: 100 }];
  assert.deepEqual(cardEdgeConvergence(samples, 100), { ms: 0.5, frames: 0, finalPosition: 100 });
});

test("the plain view convergence refuses samples that end before the gesture", { timeout: 5000 }, () => {
  assert.throws(() => cardEdgeConvergence([{ time: 90, completed: 90.5, position: 100 }], 100),
    /no measured still requested at or after the gesture end 100; the last still is requested at 90/);
});
