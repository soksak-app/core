// The reader of the U7 records of the mygo host (docs/plans/mygo-host.md, the U7 row): the frame and step records of one gesture in
// the event log, the check that the gesture lost none of them, and the times that G8 bounds. The times of a record are canonical decimal
// nanoseconds of the host event clock, the clock and the units of host.frame.surface.dispatch; every time that this module returns is in
// milliseconds. `make app-usage STEP=pointer` and the e2e benchmarks of G8 read their records through this module.

/**
 * The events of the U7 records, as the U7 row of docs/plans/mygo-host.md names them, all of the class frame at the level debug:
 * `frame`, one for each frame {window, start_ns, request_ns (null when the frame requested no presentation), end_ns, damage, nodes,
 * drawable_wait_ns, outcome, command_buffer, asks_frame, animates, repaints, timer}; `commit`, one for each command buffer committed
 * outside a frame {window, kind, commit_ns}; and `step`, one for each step of U1 {window, kind, callback, entry_ns, return_ns, forwarded,
 * wait_ns}.
 */
export const U7_EVENTS = Object.freeze({ frame: "host.frame.record", commit: "host.frame.commit", step: "host.frame.step" });

/** The kinds of a step of U1. */
const STEP_KINDS = ["selector", "block", "callback"];

const NANOSECONDS = /^(0|[1-9][0-9]*)$/;
const TIMESTAMP = /^[1-9][0-9]*$/;

/** The time `name` of a record as nanoseconds (BigInt); a field that is not canonical decimal nanoseconds is an error that names it. */
function nanos(record, name, pattern = TIMESTAMP) {
  const value = record.fields?.[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`the ${record.event} record at seq ${record.seq} has ${name} ${JSON.stringify(value)}, not canonical decimal nanoseconds`);
  }
  return BigInt(value);
}

/** The milliseconds of a duration in nanoseconds between two times of a record; a negative duration is an error that names them. */
function millis(record, from, to, duration) {
  if (duration < 0n) throw new Error(`the ${record.event} record at seq ${record.seq} has ${to} before ${from}`);
  return Number(duration) / 1e6;
}

/** The value at the rank `share` of the sorted values, the rank of the input latency check. */
export function percentile(sorted, share) {
  if (sorted.length === 0) throw new Error("a percentile needs at least one value");
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/**
 * The records of a gesture from the events that the event logs of the application gained over it (readEvents of
 * @soksak/window-check/event-log.mjs, each with its layer and seq): the U7 records and the log.dropped events of the host process, and
 * the seq range of the host process over the gesture, after fromSeq up to toSeq, the input of requireCompleteGesture. A gesture without
 * an event of the host process is an error.
 */
export function gestureRecords(events) {
  const host = events.filter((event) => event.layer === "host");
  if (host.length === 0) throw new Error("the gesture has no event of the host process");
  const u7 = new Set(Object.values(U7_EVENTS));
  const seqs = host.map((event) => event.seq);
  return {
    records: host.filter((event) => u7.has(event.event)),
    dropped: host.filter((event) => event.event === "log.dropped"),
    fromSeq: Math.min(...seqs) - 1,
    toSeq: Math.max(...seqs),
  };
}

/**
 * Requires that the records of one gesture of window are complete and returns the U7 records of that window in the order of seq.
 * records are the U7 events of the host process after seq fromSeq up to toSeq, dropped the log.dropped events of that process, and
 * framesBefore and framesAfter the frames of host.window of the window before and after the gesture. A gesture with fewer frame records
 * than the change of frames, or whose seq range contains a range that a log.dropped event names, lost records and fails with the gap.
 */
export function requireCompleteGesture({ records, dropped, window, framesBefore, framesAfter, fromSeq, toSeq }) {
  if (!Number.isInteger(framesBefore) || !Number.isInteger(framesAfter) || framesAfter < framesBefore) {
    throw new Error(`window ${window} reports frames ${JSON.stringify(framesBefore)} before the gesture and ${JSON.stringify(framesAfter)} after it`);
  }
  for (const { fields } of dropped) {
    if (!Number.isInteger(fields?.from_seq) || !Number.isInteger(fields?.to_seq)) throw new Error(`a log.dropped event has no seq range: ${JSON.stringify(fields)}`);
    if (fields.from_seq <= toSeq && fields.to_seq > fromSeq) {
      throw new Error(`the gesture of window ${window} holds seq ${fromSeq + 1} to ${toSeq}, ` +
        `which contains the range ${fields.from_seq} to ${fields.to_seq} that log.dropped names`);
    }
  }
  const own = records.filter((record) => record.fields?.window === window).toSorted((a, b) => a.seq - b.seq);
  const frameRecords = own.filter((record) => record.event === U7_EVENTS.frame).length;
  const framesChange = framesAfter - framesBefore;
  if (frameRecords < framesChange) {
    throw new Error(`the gesture of window ${window} has ${frameRecords} frame records for a change of frames of ${framesChange}; ` +
      `${framesChange - frameRecords} frame records are missing`);
  }
  return own;
}

/**
 * The time of each frame that requested a presentation, from its start to its presentation request less its wait for a drawable
 * (request_ns − start_ns − drawable_wait_ns), in the order of the records, in milliseconds (G8).
 */
export function frameTimes(records) {
  return records
    .filter((record) => record.event === U7_EVENTS.frame && record.fields?.request_ns !== null)
    .map((record) => millis(record, "start_ns", "request_ns less drawable_wait_ns",
      nanos(record, "request_ns") - nanos(record, "start_ns") - nanos(record, "drawable_wait_ns", NANOSECONDS)));
}

/**
 * The time of each step on the main thread, from its entry to its return (return_ns − entry_ns), in the order of the records, each as
 * { seq, kind, callback, entryNs, returnNs, ms } with its kind (selector, block or callback); entryNs and returnNs are BigInt nanoseconds.
 */
export function stepTimes(records) {
  return records
    .filter((record) => record.event === U7_EVENTS.step)
    .map((record) => {
      if (!STEP_KINDS.includes(record.fields.kind)) {
        throw new Error(`the ${record.event} record at seq ${record.seq} has kind ${JSON.stringify(record.fields.kind)}, not one of ${STEP_KINDS.join(", ")}`);
      }
      const entryNs = nanos(record, "entry_ns");
      const returnNs = nanos(record, "return_ns");
      return { seq: record.seq, kind: record.fields.kind, callback: record.fields.callback, entryNs, returnNs, ms: millis(record, "entry_ns", "return_ns", returnNs - entryNs) };
    });
}

/**
 * The time of the first frame of the gesture from its start to its presentation request, its wait for a drawable included
 * (request_ns − start_ns), in milliseconds (G8). A gesture without a frame, or whose first frame requested no presentation, fails.
 */
export function firstFrameMs(records) {
  const first = records.find((record) => record.event === U7_EVENTS.frame);
  if (first === undefined) throw new Error("the gesture has no frame record");
  if (first.fields?.request_ns === null) throw new Error(`the first frame of the gesture, at seq ${first.seq}, requested no presentation`);
  return millis(first, "start_ns", "request_ns", nanos(first, "request_ns") - nanos(first, "start_ns"));
}
