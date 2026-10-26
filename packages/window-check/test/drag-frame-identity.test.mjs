import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { drag } from "../app.mjs";

async function runDrag(t, options) {
  const directory = mkdtempSync(join(tmpdir(), "drag-frame-identity-"));
  const frames = join(directory, "frames");
  mkdirSync(frames);
  writeFileSync(join(frames, "callback-status.jsonl"), "{}\n");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const stoppedIdentity = { manifest: join(frames, "frame-identities", "manifest.json"), status: "complete" };
  const s = {
    app: { name: "wailsv3" },
    get: async () => ({ active: false, occluded: false }),
    presented: async () => ({ displayed: 12 }),
    trackRecording() {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "diagnostics.drag") return { frames, took: 100, asked: 100 };
      if (method === "diagnostics.capture.stop") return {
        frames,
        callbackStatus: join(frames, "callback-status.jsonl"),
        count: 2,
        limited: false,
        longestGap: 16,
        frameIdentity: stoppedIdentity,
      };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const result = await drag(t, s, { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1 }, options);
  return { calls, result, stoppedIdentity };
}

test("drag forwards opt-in frame identity and preserves the stop result", { timeout: 5000 }, async (t) => {
  const { calls, result, stoppedIdentity } = await runDrag(t, { capture: true, frameIdentity: true });
  assert.deepEqual(calls[0], {
    method: "diagnostics.drag",
    params: { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1, capture: true, frameIdentity: true },
  });
  assert.deepEqual(result.frameIdentity, stoppedIdentity);
});

test("drag preserves the legacy request when frame identity is disabled", { timeout: 5000 }, async (t) => {
  const { calls, result } = await runDrag(t, { capture: true });
  assert.deepEqual(calls[0].params, {
    axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1, capture: true,
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
      drag(t, s, { axis: "x", line: 0, dx: 10, dy: 0, ms: 100, times: 1 }, options),
      /frameIdentity must be a boolean|frameIdentity requires capture to be true/,
    );
    assert.deepEqual(calls, []);
  }
});
