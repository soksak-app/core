// Checks the measurement of the recorded frames of a window resize (e2e/resize.test.mjs): the window size and the gaps of each
// frame, the frames that the layout is behind the window, and the run evidence that keeps each measured frame.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { frameEvidence, judgeFrames, LAG, lagStages, measureFrame, writeEvidence } from "../resize-frames.mjs";

/** A frame of `width`×`height` device pixels whose top-left `bright` device columns and rows are bright. */
function recordedFrame({ width = 200, height = 160, bright = { x: 150, y: 120 }, time = 1000, scale = 2 } = {}) {
  const stride = width * 4;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < bright.y; y++) {
    for (let x = 0; x < bright.x; x++) {
      const offset = y * stride + x * 4;
      data[offset] = 200;
      data[offset + 1] = 200;
      data[offset + 2] = 200;
      data[offset + 3] = 255;
    }
  }
  return { width, height, stride, content: { x: 0, y: 0, width: width / scale, height: height / scale },
    contentScale: 1, scale, time, data };
}

/** A measured frame with the gap of the layout given in points. */
const measuredAt = (time, gap, window = { width: 400, height: 300 }) => ({ time, window, gap });

test("measureFrame reads the window size and the right and bottom gaps in points", () => {
  // 150 × 120 bright device pixels at scale 2 is a layout of 75 × 60 points in a window of 100 × 80 points.
  const measured = measureFrame(recordedFrame());
  assert.deepEqual(measured.window, { width: 100, height: 80 });
  assert.deepEqual(measured.gap, { x: 25, y: 20 });
  assert.equal(measured.time, 1000);
});

test("judgeFrames marks a frame behind when its gap differs by more than the lag, and took ends at the last behind frame", () => {
  const measured = [
    measuredAt(1000, { x: 25, y: 20 }),
    measuredAt(1050, { x: 25, y: 20 }),
    measuredAt(1100, { x: 25 + LAG, y: 20 }),
    measuredAt(1120, { x: 25 + LAG + 1, y: 20 }),
    measuredAt(1200, { x: 25, y: 20 }),
  ];
  const { behind, took } = judgeFrames(measured);
  assert.deepEqual(behind, [false, false, false, true, false]);
  assert.equal(took, 120);
});

test("judgeFrames reports no lag for a list without a frame behind the window", () => {
  assert.deepEqual(judgeFrames([measuredAt(1000, { x: 25, y: 20 })]), { behind: [false], took: 0 });
  assert.deepEqual(judgeFrames([]), { behind: [], took: 0 });
});

test("frameEvidence keeps each frame with its time, window size, gaps and behind flag, and the layout transactions", () => {
  const measured = [measuredAt(1000, { x: 25, y: 20 }), measuredAt(1120, { x: 40, y: 20 }, { width: 800, height: 600 })];
  const layouts = [{ ticket: 1, begun: 1010, requested: 1005, presented: 1080, committed: 1020 }];
  const evidence = frameEvidence({ gesture: "maximising", displayed: 1130, measured, layouts });
  assert.equal(evidence.gesture, "maximising");
  assert.equal(evidence.displayed, 1130);
  assert.equal(evidence.lag, LAG);
  assert.deepEqual(evidence.layouts, layouts);
  assert.deepEqual(evidence.frames, [
    { time: 1000, window: { width: 400, height: 300 }, gap: { x: 25, y: 20 }, behind: false },
    { time: 1120, window: { width: 800, height: 600 }, gap: { x: 40, y: 20 }, behind: true },
  ]);
});

/** An event-log line at `ms` on the frame clock. */
const logged = (ms, event, fields = {}) => ({ mono_ns: Math.round(ms * 1e6), layer: event.split(".")[0], event, fields });

test("lagStages names the layout that caught up and the view join that held its commit", () => {
  // The restore of a Tauri run: the window shrank at 229 ms, ticket 921 placed the maximised width, and ticket 922 presented
  // its DOM at 461 ms and committed at 782 ms; the frame at 789 ms is the first frame at the window size.
  const measured = [measuredAt(198, { x: 17, y: 13 }), measuredAt(275, { x: 0, y: 4 }), measuredAt(773, { x: 0, y: 4 }),
    measuredAt(789, { x: 17, y: 13 })];
  const layouts = [
    { ticket: 921, begun: 243, requested: 273, presented: 279, committed: 367 },
    { ticket: 922, begun: 426, requested: 458, presented: 461, committed: 782 },
  ];
  const events = [
    logged(229, "host.window.event", { kind: "resize", window: "main" }),
    logged(452, "host.trace.view.presentation-join", { phase: "requested", surface: "tab-a", generation: 616, ticket: 922 }),
    logged(453, "host.trace.view.presentation-join", { phase: "result", surface: "tab-a", generation: 616, ticket: 922, joined: true }),
    logged(455, "host.trace.view.presentation-join", { phase: "requested", surface: "tab-b", generation: 532, ticket: 922 }),
    logged(456, "host.trace.view.presentation-join", { phase: "result", surface: "tab-b", generation: 532, ticket: 922, joined: true }),
    logged(470, "host.trace.view.presentation-join", { phase: "presented", surface: "tab-b", generation: 532, ticket: 922 }),
    logged(781, "host.trace.view.presentation-join", { phase: "presented", surface: "tab-a", generation: 616, ticket: 922 }),
    logged(500, "host.stall", { late_ms: 120 }),
  ];
  assert.deepEqual(lagStages({ measured, layouts, events }), {
    caught: 789, resized: 229, ticket: 921 + 1, begun: 426, requested: 458, presented: 461, committed: 782,
    joins: [{ surface: "tab-a", generation: 616, requested: 452, presented: 781 },
      { surface: "tab-b", generation: 532, requested: 455, presented: 470 }],
    heldBy: "tab-a", stalls: [{ time: 500, event: "host.stall" }],
  });
});

test("lagStages reports no stage when no frame is behind and rejects a line without a monotonic time", () => {
  assert.equal(lagStages({ measured: [measuredAt(1000, { x: 25, y: 20 })], layouts: [], events: [] }), null);
  const measured = [measuredAt(0, { x: 17, y: 13 }), measuredAt(10, { x: 0, y: 4 }), measuredAt(20, { x: 17, y: 13 })];
  assert.throws(() => lagStages({ measured, layouts: [], events: [{ event: "host.window.event", fields: { kind: "resize" } }] }),
    /host.window.event has no finite mono_ns/);
});

test("writeEvidence stores the evidence in the run folder under the host and the gesture", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "resize-frames-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const evidence = frameEvidence({ gesture: "restoring", displayed: 0, measured: [], layouts: [] });
  const path = writeEvidence(join(folder, "run"), "Tauri", "restoring", evidence);
  assert.equal(path, join(folder, "run", "resize-frames-Tauri-restoring.json"));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(JSON.stringify(evidence)));
});

test("writeEvidence rejects a missing run folder with an explicit error", () => {
  assert.throws(() => writeEvidence("", "Wails", "maximising", {}), /SOKSAK_RUN_FOLDER/);
});
