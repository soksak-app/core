import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { drag } from "../app.mjs";
import { writeStillRecording } from "../still-recording.mjs";

async function runDrag(t, options) {
  const directory = mkdtempSync(join(tmpdir(), "drag-frame-identity-"));
  const frames = join(directory, "frames");
  // The 4096 stills of a recording at 8ms on a display of 125 Hz: the first three, taken until 16ms, show the steps at 4 and
  // 12ms of the drag, and the rest were stopped.
  const stopped = writeStillRecording(frames, { gap: 8, until: 4095 * 8, stoppedAt: 3, changes: [4, 12] });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const stoppedIdentity = { manifest: join(frames, "frame-identities", "manifest.json"), status: "complete" };
  const s = {
    app: { name: "wailsv3" },
    // The connection of the session, which holds the covered drawing of its windows (holdCovered).
    client: { endpoint: { pid: 4242 } },
    get: async () => ({ active: false, occluded: false, refreshRate: 125 }),
    presented: async () => ({ displayed: 12 }),
    trackRecording() {},
    request: async (method, params) => {
      if (method === "diagnostics.window.draw-covered") return null;
      calls.push({ method, params });
      if (method === "diagnostics.drag") return { frames, took: 100, asked: 100, ticks: [4, 12], layouts: [] };
      if (method === "diagnostics.capture.stop") return { ...stopped, frameIdentity: stoppedIdentity };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const result = await drag(s, { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1 }, options);
  return { calls, result, stoppedIdentity };
}

test("drag forwards opt-in frame identity and preserves the stop result", { timeout: 5000 }, async (t) => {
  const { calls, result, stoppedIdentity } = await runDrag(t, { capture: true, frameIdentity: true });
  assert.deepEqual(calls[0], {
    method: "diagnostics.drag",
    params: { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1, capture: { gap: 8, frames: 4096 }, frameIdentity: true },
  });
  assert.deepEqual(result.frameIdentity, stoppedIdentity);
});

test("drag asks for no frame identity when frame identity is disabled", { timeout: 5000 }, async (t) => {
  const { calls, result } = await runDrag(t, { capture: true });
  assert.deepEqual(calls[0].params, {
    axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1, capture: { gap: 8, frames: 4096 },
  });
  assert.equal(Object.hasOwn(result, "frameIdentity"), false);
});

test("drag rejects invalid identity options before making a request", { timeout: 5000 }, async (t) => {
  for (const options of [
    { capture: true, frameIdentity: null },
    { capture: true, frameIdentity: "true" },
    { capture: false, frameIdentity: true },
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "drag-frame-identity-invalid-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const calls = [];
    const s = {
      app: { name: "wailsv3" },
      get: async () => ({ active: false, occluded: false }),
      presented: async () => ({ displayed: 12 }),
      trackRecording() {},
      request: async (...args) => { calls.push(args); return {}; },
    };
    await assert.rejects(
      drag(s, { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1 }, options),
      /frameIdentity must be a boolean|frameIdentity requires capture to be true/,
    );
    assert.deepEqual(calls, []);
  }
});
