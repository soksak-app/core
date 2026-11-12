import assert from "node:assert/strict";
import test from "node:test";

import { B3_MEASUREMENTS } from "../benchmark/measurements.mjs";
import { resizeB3Values, uncapturedResize } from "../benchmark/cases/resize.mjs";

test("the uncaptured maximise and restore set the trace state of the frame records and record each gesture apart", { timeout: 5000 }, async () => {
  const calls = [];
  const result = await uncapturedResize({
    frameRecords: async () => { calls.push("frame records"); },
    record: async (gesture) => { calls.push("record start"); const value = await gesture(); calls.push("record end"); return { value }; },
    maximise: async () => { calls.push("maximise"); return "maximised"; },
    restore: async () => { calls.push("restore"); return "restored"; },
  });
  assert.deepEqual(calls, ["frame records", "record start", "maximise", "record end", "record start", "restore", "record end"]);
  assert.deepEqual(result, { maximise: { value: "maximised" }, restore: { value: "restored" } });
});

const ns = (micros) => String(9_000_000_000n + BigInt(micros) * 1000n);
/** The U7 records of a maximise of window w1: two requested frames and a step. */
const MAXIMISE = [
  { seq: 1, event: "host.frame.record", fields: { window: "w1", start_ns: ns(0), request_ns: ns(5000), drawable_wait_ns: "0" } },
  { seq: 2, event: "host.frame.step", fields: { window: "w1", kind: "block", callback: "layout", entry_ns: ns(5100), return_ns: ns(5600), forwarded: 0, wait_ns: "0" } },
  { seq: 3, event: "host.frame.record", fields: { window: "w1", start_ns: ns(9000), request_ns: ns(15000), drawable_wait_ns: "0" } },
];

test("the B3 values of the resize catch-up are its verdict in the state captured and the U7 figures of the maximise in the state frame-records",
  { timeout: 5000 }, () => {
    const recorded = { maximise: { result: {}, records: MAXIMISE }, restore: { result: {}, records: [] } };
    assert.deepEqual(resizeB3Values("captured", { recorded }), {});
    const frames = resizeB3Values("frame-records", { recorded });
    assert.deepEqual(frames, { maximiseFrameP90Ms: 6, maximiseStepP90Ms: 0.5 });
    assert.deepEqual(Object.keys(frames), B3_MEASUREMENTS["resize-catch-up"]["frame-records"]);
    assert.deepEqual(B3_MEASUREMENTS["resize-catch-up"].captured, ["verdict"]);
    assert.throws(() => resizeB3Values("frame-records", { recorded: null }),
      new Error("the state frame-records writes the U7 records of the maximise without capture, which a window with a main page does not have"));
    assert.throws(() => resizeB3Values("0", { recorded }),
      new Error("the resize catch-up measures in the states captured and frame-records of B3_MEASUREMENTS, not \"0\""));
  });
