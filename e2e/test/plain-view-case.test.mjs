import assert from "node:assert/strict";
import test from "node:test";

import { cardEdgeSamples, sourceIntervalSummary } from "../benchmark/cases/plain-view.mjs";

const frame = (frameTimeMs) => ({ frameTimeMs, timeRange: { lowerMs: frameTimeMs, upperMs: frameTimeMs + 1 } });

test("the plain view summary reads only the source frames that meet the gesture", { timeout: 5000 }, () => {
  const frames = [frame(0), frame(100), frame(110), frame(130), frame(170), frame(500)];
  assert.deepEqual(sourceIntervalSummary(frames, 100, 170), { count: 4, medianMs: 20, p90Ms: 40, maxMs: 40 });
});

test("the plain view summary states no interval for a single source frame", { timeout: 5000 }, () => {
  assert.deepEqual(sourceIntervalSummary([frame(100)], 100, 170), { count: 1, medianMs: null, p90Ms: null, maxMs: null });
});

test("the plain view edge samples keep the measured frames and name the others", { timeout: 5000 }, () => {
  const frames = [{ time: 1, edge: 100 }, { time: 2, edge: null }, { time: 3, edge: 110 }];
  assert.deepEqual(cardEdgeSamples(frames, (frame) => frame.edge), {
    samples: [{ time: 1, position: 100 }, { time: 3, position: 110 }],
    unmeasured: [1],
  });
});
