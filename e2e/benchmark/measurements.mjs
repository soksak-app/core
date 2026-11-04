// The keys of the B3 output of each e2e benchmark (docs/plans/mygo-host.md, B3), by the name of its file. A benchmark run with
// SOKSAK_B3_OUT writes a subset of its keys to the output through scripts/b3-out.mjs. One output holds the keys of the interval that was
// measured in one trace state, so the view drag and the resize catch-up, which measure in the trace state 0 and in the trace state of
// the frame records (FRAME_RECORDS of scripts/measure-trace.mjs), declare their keys for each state that SOKSAK_B3_TRACE names. A key
// ends in its unit (Kb, Ms, Seconds, PerSecond), a count is bare, and `verdict` is "passed" or "failed".
//   view-drag 0                 verdict; peakBeforeDragKb and peakAfterDragKb, the summed peak footprints of the processes of the
//                               application before and after the first drag; dragCpuSeconds, their CPU time over the first drag
//   view-drag frame-records     dragFrameP90Ms, the 90th percentile of the frame time less the drawable wait, dragStepP90Ms, the 90th
//                               percentile of the steps with their forwarded calls, and dragFirstFrameMs, the time of the first frame,
//                               of the third drag on a window without a main page
//   resize-catch-up 0           verdict
//   resize-catch-up frame-records  maximiseFrameP90Ms and maximiseStepP90Ms of the maximise without capture on a window without a
//                               main page
//   split-load                  hostGrowthKb, the growth of the host process under load
//   idle-tab                    idleTabCostKb, the cost of the idle tab, and documentPartKb, its part in documents
//   *-view, editor-footprint    verdict
//   input-latency               terminalMedianMs, terminalP90Ms, termMedianMs and termP90Ms, the keys of the configurations with the
//                               trace off and the default gate

const keys = (...names) => Object.freeze(names);

/** The keys of the B3 output of each benchmark, and of each trace state of the benchmarks that measure in two. */
export const B3_MEASUREMENTS = Object.freeze({
  "view-drag": Object.freeze({
    "0": keys("verdict", "peakBeforeDragKb", "peakAfterDragKb", "dragCpuSeconds"),
    "frame-records": keys("dragFrameP90Ms", "dragStepP90Ms", "dragFirstFrameMs"),
  }),
  "resize-catch-up": Object.freeze({
    "0": keys("verdict"),
    "frame-records": keys("maximiseFrameP90Ms", "maximiseStepP90Ms"),
  }),
  "split-load": keys("hostGrowthKb"),
  "idle-tab": keys("idleTabCostKb", "documentPartKb"),
  "browser-view": keys("verdict"),
  "editor-view": keys("verdict"),
  "hwp-view": keys("verdict"),
  "terminal-view": keys("verdict"),
  "term-view": keys("verdict"),
  "section-view": keys("verdict"),
  "editor-footprint": keys("verdict"),
  "input-latency": keys("terminalMedianMs", "terminalP90Ms", "termMedianMs", "termP90Ms"),
});
