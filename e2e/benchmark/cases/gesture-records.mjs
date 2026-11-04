// The U7 records of a gesture of a benchmark on a window whose host.window reports pageProcess null, the window of the mygo host
// (docs/spec/hosts.md, U7 and G8). The view drag and the resize catch-up run the gesture under the trace state of the frame records
// (FRAME_RECORDS of scripts/measure-trace.mjs), read the records that the host event log gained over it and judge them through the reader
// of scripts/frame-records.mjs: a gesture with fewer frame records than the change of `frames` of host.window over it, or with a seq
// range that a log.dropped event names, fails.
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { firstFrameMs, frameTimes, gestureRecords, percentile, requireCompleteGesture, stepTimes } from "../../../scripts/frame-records.mjs";

/**
 * Runs `gesture()` on the window of the session `s` and returns its result and the complete U7 records of the window over it. frames of
 * host.window is read before and after the gesture, and the log is flushed after the second reading, so that the files hold the record
 * of every frame that the second reading counts.
 */
export async function recordGesture(s, gesture) {
  const { frames: framesBefore } = await s.get("host.window");
  const offsets = currentEventOffsets(s.app.configDir);
  const result = await gesture();
  const { frames: framesAfter } = await s.get("host.window");
  await s.flushLog();
  const read = gestureRecords(readEvents(s.app.configDir, offsets).events);
  return { result, records: requireCompleteGesture({ ...read, window: s.window, framesBefore, framesAfter }) };
}

/** The 90th percentile of `values`; a gesture without one is an error that names `what`. */
function p90(values, what) {
  if (values.length === 0) throw new Error(`the gesture has no ${what}`);
  return percentile(values.toSorted((a, b) => a - b), 0.9);
}

/**
 * The B3 values of the U7 records of one gesture under `prefix`: `<prefix>FrameP90Ms`, the 90th percentile of the frame time less the
 * drawable wait, `<prefix>StepP90Ms`, the 90th percentile of the steps of every kind, each timed from its entry to its return with its
 * forwarded calls, and with `firstFrame` `<prefix>FirstFrameMs`, the time of the first frame from its start to its presentation request.
 */
export function gestureB3Values(prefix, records, { firstFrame }) {
  return {
    [`${prefix}FrameP90Ms`]: p90(frameTimes(records), "frame record with a presentation request"),
    [`${prefix}StepP90Ms`]: p90(stepTimes(records).map(({ ms }) => ms), "step record"),
    ...(firstFrame ? { [`${prefix}FirstFrameMs`]: firstFrameMs(records) } : {}),
  };
}
