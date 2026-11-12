// The keys of the B3 output of each e2e benchmark (docs/operations/examples.md, B3), by the name of its file. A benchmark run with
// SOKSAK_B3_OUT writes a subset of its keys to the output through scripts/b3-out.mjs. One output holds the keys of the interval that was
// measured in one state, so the view drag, which measures in the trace state 0 and in the trace state of the frame records (FRAME_RECORDS
// of scripts/measure-trace.mjs), and the resize catch-up, which measures its captured gestures in the state `captured` and its gestures
// without capture in the trace state of the frame records, declare their keys for each state that SOKSAK_B3_TRACE names. A key
// ends in its unit (Kb, Ms, Seconds, PerSecond), a count is bare, and `verdict` is "passed" or "failed".
//   view-drag 0                 verdict; peakBeforeDragKb and peakAfterDragKb, the summed peak footprints of the processes of the
//                               application before and after the first drag; dragCpuSeconds, their CPU time over the first drag
//   view-drag frame-records     dragFrameP90Ms, the 90th percentile of the frame time less the drawable wait, dragStepP90Ms, the 90th
//                               percentile of the steps with their forwarded calls, and dragFirstFrameMs, the time of the first frame,
//                               of the third drag on a window without a main page
//   resize-catch-up captured    verdict
//   resize-catch-up frame-records  maximiseFrameP90Ms and maximiseStepP90Ms of the maximise without capture on a window without a
//                               main page
//   split-load                  hostGrowthKb, the growth of the host process under load
//   idle-tab                    idleTabCostKb, the cost of the idle tab, and documentPartKb, its part in documents
//   section-view                verdict
//   input-latency               fieldMedianMs, fieldP90Ms, documentMedianMs and documentP90Ms, the keys of the configurations with the
//                               trace off and the default gate

import { FRAME_RECORDS, traceSettings } from "../../scripts/measure-trace.mjs";

const keys = (...names) => Object.freeze(names);

/** The keys of the B3 output of each benchmark, and of each state of the benchmarks that measure in two. */
export const B3_MEASUREMENTS = Object.freeze({
  "view-drag": Object.freeze({
    "0": keys("verdict", "peakBeforeDragKb", "peakAfterDragKb", "dragCpuSeconds"),
    "frame-records": keys("dragFrameP90Ms", "dragStepP90Ms", "dragFirstFrameMs"),
  }),
  "resize-catch-up": Object.freeze({
    captured: keys("verdict"),
    "frame-records": keys("maximiseFrameP90Ms", "maximiseStepP90Ms"),
  }),
  "split-load": keys("hostGrowthKb"),
  "idle-tab": keys("idleTabCostKb", "documentPartKb"),
  "section-view": keys("verdict"),
  "input-latency": keys("fieldMedianMs", "fieldP90Ms", "documentMedianMs", "documentP90Ms"),
});

/** The frozen settings of `performance`, the value of diagnostics.performance, and `log`, the value of diagnostics.log. */
const settings = (performance, log) => Object.freeze({ "diagnostics.performance": performance, "diagnostics.log": Object.freeze({ ...log }) });
/** The frozen settings of a trace state of scripts/measure-trace.mjs. */
const trace = (state) => {
  const { "diagnostics.performance": performance, "diagnostics.log": log } = traceSettings(state);
  return settings(performance, log);
};
// The process starts of a view (host.trace.view.process-request and process-ready) are stored in the class call at debug and its
// content frames (plugin.<plugin>.view.content_frame) in the class frame at trace.
const VIEW = settings(true, { call: "debug", frame: "trace" });

/**
 * The settings of each state of each benchmark, in the form of traceSettings of scripts/measure-trace.mjs, with the benchmarks and the
 * states of B3_MEASUREMENTS. A state of a trace state is that state's traceSettings; every other state names the classes that its
 * evidence needs. The benchmark applies the settings of its state (fixtureSettings of cases/b3-run.mjs) and fails when the conditions of
 * its interval differ from them (b3Conditions of cases/b3-run.mjs); the B3 judge compares the conditions of each output with them.
 */
export const B3_SETTINGS = Object.freeze({
  "view-drag": Object.freeze({ "0": trace(0), [FRAME_RECORDS]: trace(FRAME_RECORDS) }),
  "resize-catch-up": Object.freeze({
    // The window events, the view joins and the layout phases of the captured gestures (F292-41), which the performance trace stores
    // in the classes lifecycle, call and frame at debug.
    captured: settings(true, { lifecycle: "debug", call: "debug", frame: "debug" }),
    [FRAME_RECORDS]: trace(FRAME_RECORDS),
  }),
  // The stress needs no event of the application: the check times the phases of its rounds itself (phasedSession of
  // reload-phases.mjs), so the performance trace stays off and every class keeps its default level, the settings of the trace state 0.
  "split-load": trace(0),
  // The memory readings of the sampler of the performance trace (host.sampler.memory) are stored in the class call at debug.
  "idle-tab": settings(true, { call: "debug" }),
  "section-view": VIEW,
  "input-latency": trace(0),
});
