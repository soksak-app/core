import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { gestureB3Values, recordGesture } from "../benchmark/cases/gesture-records.mjs";

const W = "w1";
const ns = (micros) => String(9_000_000_000n + BigInt(micros) * 1000n);
const frame = (seq, start, request, wait, window = W) => ({ layer: "host", seq, event: "host.frame.record", fields: {
  window, start_ns: ns(start), request_ns: request === null ? null : ns(request), end_ns: ns((request ?? start) + 500), damage: true, nodes: 40,
  drawable_wait_ns: String(wait * 1000), outcome: request === null ? "undamaged" : "transaction", command_buffer: request !== null,
  asks_frame: true, animates: false, repaints: false, timer: false } });
const step = (seq, kind, callback, entry, back) => ({ layer: "host", seq, event: "host.frame.step", fields: {
  window: W, kind, callback, entry_ns: ns(entry), return_ns: ns(back), forwarded: 2, wait_ns: "0" } });

/** The events of a drag of the mygo host: three frames of w1 (one without a presentation request), four steps and a frame of w2. */
const DRAG = [
  { layer: "host", seq: 101, event: "host.window.event", fields: { window: W, kind: "drag" } },
  step(102, "selector", "mouseDown:", 0, 400),
  frame(103, 1000, 4000, 1000),
  step(104, "selector", "mouseDragged:", 6000, 7500),
  frame(105, 8000, null, 0),
  step(106, "block", "present", 8300, 8500),
  frame(107, 9000, 13000, 0),
  step(108, "callback", "displayLink", 15000, 15100),
  frame(109, 16000, 17000, 0, "w2"),
];

/** A session of a mygo window whose log flush appends `events` to the host log of a temporary configuration folder. */
function mygoSession(t, events) {
  const configDir = mkdtempSync(join(tmpdir(), "gesture-records-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  mkdirSync(join(configDir, "logs"));
  const file = join(configDir, "logs", "host-1-2.debug.jsonl");
  const line = (event) => `${JSON.stringify({ level: "debug", ...event })}\n`;
  writeFileSync(file, line({ layer: "host", seq: 100, event: "host.window.event", fields: {} }));
  const session = {
    window: W,
    app: { configDir },
    frames: 10,
    calls: [],
    get: async (name) => { session.calls.push(`get ${name}`); return { pageProcess: null, frames: session.frames, commandBuffers: session.frames, settled: true }; },
    flushLog: async () => { session.calls.push("flush"); for (const event of events) appendFileSync(file, line(event)); },
  };
  return session;
}

test("a recorded gesture reads frames before and after it, then flushes the log and returns the complete U7 records of its window", { timeout: 5000 }, async (t) => {
  const s = mygoSession(t, DRAG);
  const recorded = await recordGesture(s, async () => { s.calls.push("gesture"); s.frames += 3; return "dragged"; });
  assert.deepEqual(s.calls, ["get host.window", "gesture", "get host.window", "flush"]);
  assert.equal(recorded.result, "dragged");
  assert.deepEqual(recorded.records.map(({ seq }) => seq), [102, 103, 104, 105, 106, 107, 108]);
});

test("a recorded gesture with fewer frame records than the change of frames fails", { timeout: 5000 }, async (t) => {
  const s = mygoSession(t, DRAG);
  await assert.rejects(recordGesture(s, async () => { s.frames += 4; }),
    /the gesture of window w1 has 3 frame records for a change of frames of 4; 1 frame records are missing/);
});

test("the B3 values of a gesture are the 90th percentiles of its frame and step times and, for a drag, its first frame", { timeout: 5000 }, async (t) => {
  const s = mygoSession(t, DRAG);
  const { records } = await recordGesture(s, async () => { s.frames += 3; });
  assert.deepEqual(gestureB3Values("drag", records, { firstFrame: true }), { dragFrameP90Ms: 4, dragStepP90Ms: 1.5, dragFirstFrameMs: 3 });
  assert.deepEqual(gestureB3Values("maximise", records, { firstFrame: false }), { maximiseFrameP90Ms: 4, maximiseStepP90Ms: 1.5 });
  assert.throws(() => gestureB3Values("drag", records.filter(({ event }) => event !== "host.frame.step"), { firstFrame: false }),
    new Error("the gesture has no step record"));
  assert.throws(() => gestureB3Values("drag", records.filter(({ event }) => event !== "host.frame.record"), { firstFrame: false }),
    new Error("the gesture has no frame record with a presentation request"));
});
