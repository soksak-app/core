// Records the maximize and restore of the window, checks that the app layout matches the window size after the change ends, and reports
// the number of frames in which the layout was later than the window during the change. The time of the catch-up is kept as a measured
// value in the run evidence; its limit is judged by the benchmark (e2e/benchmark/resize-catch-up.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open, RECORDING } from "@soksak/window-check/app.mjs";
import { recordMaximiseAndRestore } from "./benchmark/cases/resize.mjs";
import { judgeFrames } from "./resize-frames.mjs";

/**
 * Checks that the layout of the last displayed frame after the change ends matches the window size, and reports the number of frames in which the layout
 * was later than the window during the change. The window frame and the WebKit content are displayed separately (WebKit/WebKit#72971,
 * tauri-apps/tao#1207), so late frames during the change remain only as a measured value.
 */
function assertSettled(t, { displayed, measured, stages }, label) {
  assert.ok(measured.length > 1, `${label}: only ${measured.length} frames were recorded`);
  const [first] = measured;
  const last = measured.at(-1);
  const tail = measured.slice(-5).map((m) =>
    `${(m.time - first.time).toFixed(0)}ms ${m.window.width.toFixed(0)}×${m.window.height.toFixed(0)} gap ${m.gap.x.toFixed(0)},${m.gap.y.toFixed(0)}`);
  const shown = `presented for display at ${(displayed - first.time).toFixed(0)}ms`;
  assert.ok(Math.abs(last.window.width - first.window.width) > 100,
    `${label}: the recording did not include the resized window (${first.window.width} → ${last.window.width}; ` +
    `${shown}; last frames ${tail.join(", ")})`);
  const { behind, took } = judgeFrames(measured);
  t.diagnostic(`${label}: ${behind.filter(Boolean).length} of ${measured.length} frames show the layout behind the window, the last at ${took.toFixed(0)}ms`);
  assert.ok(!behind.at(-1), `${label}: the settled frame shows the layout behind the window ` +
    `(window ${last.window.width.toFixed(0)}×${last.window.height.toFixed(0)}, gap ${last.gap.x.toFixed(0)},${last.gap.y.toFixed(0)}, ` +
    `base gap ${first.gap.x.toFixed(0)},${first.gap.y.toFixed(0)}; ${shown}; last frames ${tail.join(", ")}; stages ${JSON.stringify(stages)})`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising and restoring settle with the layout at the window size`, RECORDING, async (t) => {
    const s = await open(t, app);
    await recordMaximiseAndRestore(s, (gesture, recorded) => assertSettled(t, recorded, gesture));
  });
}
