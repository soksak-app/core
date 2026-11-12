import assert from "node:assert/strict";
import test from "node:test";

import { firstFrameMs, frameTimes, gestureRecords, percentile, requireCompleteGesture, stepTimes, U7_EVENTS } from "../frame-records.mjs";

/** The canonical decimal nanoseconds of the host event clock at `micros` microseconds after a clock reading of 9 s. */
const ns = (micros) => String(9_000_000_000n + BigInt(micros) * 1000n);

/** A frame record of window w1 with its times in microseconds; request is null for a frame that requested no presentation. */
function frame(seq, { start, request, wait = 0, window = "w1" }) {
  return {
    seq,
    event: "host.frame.record",
    fields: {
      window, start_ns: ns(start), request_ns: request === null ? null : ns(request), end_ns: ns((request ?? start) + 500), damage: 12288, nodes: 48,
      drawable_wait_ns: String(wait * 1000), outcome: request === null ? "undamaged" : "transaction", command_buffer: request !== null,
      asks_frame: false, animates: false, repaints: false, timer: false,
    },
  };
}

/** A step record of window w1 with its entry and return in microseconds. */
function step(seq, { kind = "selector", callback, entry, back, window = "w1" }) {
  return { seq, event: "host.frame.step", fields: { window, kind, callback, entry_ns: ns(entry), return_ns: ns(back), forwarded: 6, wait_ns: "40000" } };
}

test("the U7 events are the frame, commit, completion and step records that the U7 row of the plan names", () => {
  assert.deepEqual(U7_EVENTS, { frame: "host.frame.record", commit: "host.frame.commit", complete: "host.frame.complete", step: "host.frame.step" });
  assert.ok(Object.isFrozen(U7_EVENTS));
});

test("the 90th percentile takes the value at the rank of 90 of 100 values", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10);
  assert.equal(percentile([1, 2, 3], 0.9), 3);
  assert.equal(percentile([4, 8, 15, 16, 23, 42, 50, 60, 70, 80, 90], 0.9), 80);
  assert.throws(() => percentile([], 0.9), /a percentile needs at least one value/);
});

const GESTURE = [
  step(103, { callback: "mouseMoved:", entry: 1000, back: 2000 }),
  frame(104, { start: 2000, request: 5000, wait: 1000 }),
  step(101, { callback: "hitTest:", entry: 0, back: 1000 }),
  frame(105, { start: 9000, request: null }),
  step(102, { callback: "hitTest:", entry: 0, back: 1000, window: "w2" }),
];

test("a complete gesture returns the U7 records of its window in the order of seq", () => {
  const own = requireCompleteGesture({ records: GESTURE, dropped: [], window: "w1", framesBefore: 340, framesAfter: 342, fromSeq: 100, toSeq: 105 });
  assert.deepEqual(own.map(({ seq }) => seq), [101, 103, 104, 105]);
});

test("a gesture with fewer frame records than the change of frames fails and names the missing records", () => {
  assert.throws(() => requireCompleteGesture({ records: GESTURE, dropped: [], window: "w1", framesBefore: 340, framesAfter: 345, fromSeq: 100, toSeq: 105 }),
    /the gesture of window w1 has 2 frame records for a change of frames of 5; 3 frame records are missing/);
  assert.throws(() => requireCompleteGesture({ records: GESTURE, dropped: [], window: "w1", framesBefore: null, framesAfter: 342, fromSeq: 100, toSeq: 105 }),
    /window w1 reports frames null before the gesture and 342 after it/);
});

test("a gesture that contains a seq range that a log.dropped event names fails", () => {
  const dropped = [{ seq: 106, event: "log.dropped", fields: { from_seq: 103, to_seq: 104, count: 2, bytes: 400, reason: "queue full", channel: "debug" } }];
  assert.throws(() => requireCompleteGesture({ records: GESTURE, dropped, window: "w1", framesBefore: 340, framesAfter: 342, fromSeq: 100, toSeq: 106 }),
    /the gesture of window w1 holds seq 101 to 106, which contains the range 103 to 104 that log.dropped names/);
  const earlier = [{ seq: 90, event: "log.dropped", fields: { from_seq: 80, to_seq: 85 } }];
  assert.equal(requireCompleteGesture({ records: GESTURE, dropped: earlier, window: "w1", framesBefore: 340, framesAfter: 342, fromSeq: 100, toSeq: 105 }).length, 4);
  assert.throws(() => requireCompleteGesture({ records: GESTURE, dropped: [{ fields: { count: 2 } }], window: "w1", framesBefore: 340, framesAfter: 342, fromSeq: 100, toSeq: 105 }),
    /a log.dropped event has no seq range: \{"count":2\}/);
});

test("the frame time runs from the start of a frame to its presentation request less its wait for a drawable", () => {
  const own = requireCompleteGesture({ records: GESTURE, dropped: [], window: "w1", framesBefore: 340, framesAfter: 342, fromSeq: 100, toSeq: 105 });
  assert.deepEqual(frameTimes(own), [2]);
  const unread = { ...frame(110, { start: 0, request: 100 }), fields: { ...frame(110, { start: 0, request: 100 }).fields, drawable_wait_ns: 7 } };
  assert.throws(() => frameTimes([unread]), /the host.frame.record record at seq 110 has drawable_wait_ns 7, not canonical decimal nanoseconds/);
});

test("the step time runs from the entry of each step to its return and keeps the kind of the step", () => {
  const times = stepTimes([step(1, { callback: "hitTest:", entry: 0, back: 1500 }), step(2, { kind: "block", callback: "block 3", entry: 2000, back: 2250 })]);
  assert.deepEqual(times.map(({ seq, kind, callback, ms }) => ({ seq, kind, callback, ms })),
    [{ seq: 1, kind: "selector", callback: "hitTest:", ms: 1.5 }, { seq: 2, kind: "block", callback: "block 3", ms: 0.25 }]);
  assert.deepEqual([times[0].entryNs, times[0].returnNs], [9_000_000_000n, 9_001_500_000n]);
  assert.throws(() => stepTimes([step(3, { kind: "thread", callback: "x", entry: 0, back: 1 })]),
    /the host.frame.step record at seq 3 has kind "thread", not one of selector, block, callback/);
  assert.throws(() => stepTimes([step(4, { callback: "x", entry: 10, back: 1 })]), /the host.frame.step record at seq 4 has return_ns before entry_ns/);
});

test("the first frame time runs from the start of the first frame of the gesture to its presentation request", () => {
  assert.equal(firstFrameMs([step(1, { callback: "mouseDragged:", entry: 0, back: 10 }), frame(2, { start: 100, request: 4100, wait: 2000 }), frame(3, { start: 9000, request: 9500 })]), 4);
  assert.throws(() => firstFrameMs([frame(5, { start: 0, request: null }), frame(6, { start: 10, request: 20 })]),
    /the first frame of the gesture, at seq 5, requested no presentation/);
  assert.throws(() => firstFrameMs([step(1, { callback: "x", entry: 0, back: 1 })]), /the gesture has no frame record/);
});

test("the records of a gesture in the event log are the U7 records and the log.dropped events of the host process, with its seq range", () => {
  const host = (record) => ({ layer: "host", ...record });
  const events = [
    host({ seq: 101, event: "host.window.event", fields: { window: "w1", kind: "drag" } }),
    host(step(102, { callback: "mouseDragged:", entry: 0, back: 1000 })),
    host(frame(103, { start: 1000, request: 3000 })),
    host({ seq: 104, event: "host.frame.commit", fields: { window: "w1", kind: "layer", commit_ns: ns(3500) } }),
    host({ seq: 105, event: "host.frame.complete", fields: { window: "w1", commit_ns: ns(3500), complete_ns: ns(4200) } }),
    host({ seq: 106, event: "log.dropped", fields: { from_seq: 90, to_seq: 95, count: 6, bytes: 600, reason: "queue full", channel: "debug" } }),
    { layer: "sidecar", seq: 7, event: "host.frame.record", fields: { window: "w1" } },
    { layer: "page", seq: 300, event: "page.start", fields: {} },
  ];
  const read = gestureRecords(events);
  assert.deepEqual(read.records.map(({ seq }) => seq), [102, 103, 104, 105]);
  assert.deepEqual(read.dropped.map(({ seq }) => seq), [106]);
  assert.deepEqual([read.fromSeq, read.toSeq], [100, 106]);
  assert.equal(requireCompleteGesture({ ...read, window: "w1", framesBefore: 10, framesAfter: 11 }).length, 4);
  assert.throws(() => gestureRecords(events.slice(6)), /the gesture has no event of the host process/);
});
