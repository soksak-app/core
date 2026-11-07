import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { TERMINAL_DRAG_PLAN } from "../benchmark/cases/terminal.mjs";
import { B3_MEASUREMENTS } from "../benchmark/measurements.mjs";
import { completeViewDrag, dragProcesses, firstDragFigures, NATIVE_DRAG_PLAN, runViewDrag, viewDragB3Values, viewDragOptions } from "../benchmark/cases/view-drag.mjs";

test("the benchmark defers captured thresholds until valid third-drag measurements are published", { timeout: 5000 }, () => {
  const source = readFileSync(new URL("../benchmark/view-drag.test.mjs", import.meta.url), "utf8");
  const capture = source.slice(source.indexOf("capturedDrag: async () => {"), source.indexOf("untilFramesQuiet:"));
  assert.ok(capture.includes("assert.ok(report.frameCount > 30"), "capture completeness must still be validated before continuing");
  assert.ok(!capture.includes("assertPerformance("), "captured performance must not prevent third-drag collection");
  assert.match(source, /publish: async \(\{ elements, recorded \}\) =>/, "the actual benchmark must publish collected results through runViewDrag");
  const publish = source.slice(source.indexOf("publish: async"));
  assert.match(publish, /Object\.assign\(run\.measurements, viewDragB3Values\(/);
  const runner = readFileSync(new URL("../benchmark/cases/view-drag.mjs", import.meta.url), "utf8");
  const collection = runner.slice(runner.indexOf("export async function runViewDrag("), runner.indexOf("export async function completeViewDrag("));
  assert.match(collection, /await completeViewDrag\(captured, async \(\) =>/);
  assert.match(collection, /await steps\.publish\(result\)/);
});

test("valid view drags publish third-stage B3 values before a captured threshold failure", { timeout: 5000 }, async () => {
  const calls = [];
  const threshold = new Error("captured frame p90 exceeds the unchanged target");
  const captured = { assertPerformance() { calls.push("captured thresholds"); throw threshold; } };
  const measurements = {};
  await assert.rejects(async () => completeViewDrag(captured, () => {
    calls.push("publish third metrics");
    Object.assign(measurements, viewDragB3Values("frame-records", { recorded: { records: THIRD_DRAG }, gcLoop: false }));
  }), (error) => error === threshold);
  assert.deepEqual(calls, ["publish third metrics", "captured thresholds"]);
  assert.deepEqual(measurements, { dragFrameP90Ms: 4, dragStepP90Ms: 1.5, dragFirstFrameMs: 3 });
});

test("view-drag judgment preserves both invalid third metrics and captured threshold failures", { timeout: 5000 }, async () => {
  const threshold = new Error("captured step p90 exceeds the unchanged target");
  let metricFailure;
  let judgments = 0;
  await assert.rejects(async () => completeViewDrag({ assertPerformance() { judgments++; throw threshold; } }, () => {
    try { viewDragB3Values("frame-records", { recorded: null, gcLoop: false }); }
    catch (error) { metricFailure = error; throw error; }
  }), (error) => error instanceof AggregateError && error.errors.length === 2 &&
    error.errors[0] === metricFailure && error.errors[1] === threshold);
  assert.equal(judgments, 1, "invalid metrics must not hide the captured threshold failure");
});

test("view-drag judgment retains a metrics-only failure and accepts only two successful judgments", { timeout: 5000 }, async () => {
  const metricFailure = new Error("invalid frame records");
  let judgments = 0;
  const captured = { assertPerformance() { judgments++; } };
  await assert.rejects(async () => completeViewDrag(captured, () => { throw metricFailure; }), (error) => error === metricFailure);
  await completeViewDrag(captured, () => {});
  assert.equal(judgments, 2);
});

test("a structurally invalid captured drag prevents the third drag and metric publication", { timeout: 5000 }, async () => {
  const calls = [];
  const invalid = new Error("captured geometry is incomplete");
  const steps = recordingSteps(calls);
  steps.capturedDrag = async () => { calls.push("capture validation"); throw invalid; };
  await assert.rejects(runViewDrag({ options: { accessibility: false, floor: false, gcLoop: false }, pageProcess: null, steps }),
    (error) => error === invalid);
  assert.deepEqual(calls, ['conditions "0"', "processes", "native drag", "processes", "first drag 0.5 s", "capture validation"]);
});

test("a third-stage collection failure preserves the valid captured threshold failure exactly once", { timeout: 5000 }, async () => {
  const calls = [];
  const collectionFailure = new Error("third drag record collection failed");
  const threshold = new Error("captured frame p90 exceeds the unchanged target");
  let judgments = 0;
  const steps = recordingSteps(calls);
  steps.capturedDrag = async () => ({ assertPerformance() { judgments++; throw threshold; } });
  steps.record = async () => { throw collectionFailure; };
  steps.publish = async () => { assert.fail("incomplete third-stage collection must not publish metrics"); };
  await assert.rejects(runViewDrag({ options: { accessibility: false, floor: false, gcLoop: false }, pageProcess: null, steps }),
    (error) => error instanceof AggregateError && error.errors.length === 2 &&
      error.errors[0] === collectionFailure && error.errors[1] === threshold);
  assert.equal(judgments, 1, "a valid capture must be judged even when third-stage collection fails");
});

test("the view drag takes ACCESSIBILITY, FLOOR and GC_LOOP as unset or 1", { timeout: 5000 }, () => {
  assert.deepEqual(viewDragOptions({}), { accessibility: false, floor: false, gcLoop: false });
  assert.deepEqual(viewDragOptions({ SOKSAK_ACCESSIBILITY: "1", SOKSAK_FLOOR: "1", SOKSAK_GC_LOOP: "1" }),
    { accessibility: true, floor: true, gcLoop: true });
  assert.throws(() => viewDragOptions({ SOKSAK_GC_LOOP: "0" }), new Error("SOKSAK_GC_LOOP must be unset or 1, not \"0\""));
  assert.throws(() => viewDragOptions({ SOKSAK_FLOOR: "" }), new Error("SOKSAK_FLOOR must be unset or 1, not \"\""));
});

test("the first drag is the captured drag without capture, delivered as native input", { timeout: 5000 }, () => {
  assert.deepEqual(TERMINAL_DRAG_PLAN, { axis: "x", line: 1, dx: 250, dy: 0, ms: 400, times: 2 });
  assert.deepEqual(NATIVE_DRAG_PLAN, { ...TERMINAL_DRAG_PLAN, native: true });
});

const CAPTURED = { frameCount: 50, assertPerformance() {} };
/** The steps of a view drag that record their calls in `calls`; `fail` names a step that throws. */
function recordingSteps(calls, fail = new Set()) {
  const step = (name, value) => async (...args) => {
    calls.push(args.length ? `${name} ${args.join(" ")}` : name);
    if (fail.has(name)) throw new Error(`${name} failed`);
    return value;
  };
  return {
    readElements: step("elements", ["AXWindow"]),
    readProcesses: async () => {
      const at = calls.filter((call) => call === "processes").length;
      calls.push("processes");
      return [{ role: "host", pid: 7, cpuSeconds: at === 0 ? 1 : 1.5, peakBytes: at === 0 ? 100 * 1024 : 140 * 1024 }];
    },
    nativeDrag: step("native drag", { took: 800 }),
    capturedDrag: step("captured drag", CAPTURED),
    untilFramesQuiet: step("frames quiet"),
    frameRecords: step("frame records"),
    gcLoop: step("gc loop"),
    uncapturedDrag: step("uncaptured drag", { took: 800 }),
    record: async (gesture) => { calls.push("record start"); const result = await gesture(); calls.push("record end"); return { result }; },
    conditions: async (state) => { calls.push(`conditions ${JSON.stringify(state)}`); },
    firstDragRead: async (figures) => { calls.push(`first drag ${figures.cpuSeconds} s`); },
    publish: async () => { calls.push("publish"); },
  };
}

test("the view drag runs the drags of B3 in order and reads the processes around the first and the elements before them", { timeout: 5000 }, async () => {
  const calls = [];
  const result = await runViewDrag({ options: { accessibility: true, floor: false, gcLoop: true }, pageProcess: null, steps: recordingSteps(calls) });
  assert.deepEqual(calls, [
    "elements", 'conditions "0"', "processes", "native drag", "processes", "first drag 0.5 s", "captured drag", "frames quiet",
    "frame records", 'conditions "frame-records"', "record start", "gc loop true", "uncaptured drag", "gc loop false", "record end", "publish",
  ]);
  assert.deepEqual(result, { elements: ["AXWindow"], captured: CAPTURED, recorded: { result: { took: 800 } } });
});

test("without ACCESSIBILITY and GC_LOOP the view drag reads no element and leaves the collector alone", { timeout: 5000 }, async () => {
  const calls = [];
  await runViewDrag({ options: { accessibility: false, floor: false, gcLoop: false }, pageProcess: 812, steps: recordingSteps(calls) });
  assert.deepEqual(calls, [
    'conditions "0"', "processes", "native drag", "processes", "first drag 0.5 s", "captured drag", "frames quiet", "frame records",
    'conditions "frame-records"', "record start", "uncaptured drag", "record end", "publish",
  ]);
});

test("GC_LOOP needs a window without a main page", { timeout: 5000 }, async () => {
  const calls = [];
  await assert.rejects(runViewDrag({ options: { accessibility: false, floor: false, gcLoop: true }, pageProcess: 812, steps: recordingSteps(calls) }),
    new Error("GC_LOOP=1 turns diagnostics.gc.loop on in the mygo host, a window whose host.window reports pageProcess null, not 812"));
  assert.deepEqual(calls, []);
});

test("a failed third drag turns the collector loop off, and a failure of both is reported with both causes", { timeout: 5000 }, async () => {
  const calls = [];
  await assert.rejects(runViewDrag({ options: { accessibility: false, floor: false, gcLoop: true }, pageProcess: null,
    steps: recordingSteps(calls, new Set(["uncaptured drag"])) }), new Error("uncaptured drag failed"));
  assert.deepEqual(calls.slice(-3), ["gc loop true", "uncaptured drag", "gc loop false"]);

  const both = [];
  const steps = recordingSteps(both, new Set(["uncaptured drag"]));
  steps.gcLoop = async (on) => { both.push(`gc loop ${on}`); if (!on) throw new Error("the loop did not stop"); };
  await assert.rejects(runViewDrag({ options: { accessibility: false, floor: false, gcLoop: true }, pageProcess: null, steps }),
    (error) => error instanceof AggregateError &&
      error.errors.map(({ message }) => message).join(", ") === "uncaptured drag failed, the loop did not stop" &&
      error.message === "the third drag failed (uncaptured drag failed) and turning diagnostics.gc.loop off failed (the loop did not stop)");
});

test("the figures of the first drag are the CPU time and the peak footprint of each process before and after it", { timeout: 5000 }, () => {
  const before = [{ role: "host", pid: 7, cpuSeconds: 1, peakBytes: 100 * 1024 }, { role: "sidecar vt", pid: 9, cpuSeconds: 2, peakBytes: 50 * 1024 }];
  const after = [{ role: "host", pid: 7, cpuSeconds: 1.25, peakBytes: 140 * 1024 }, { role: "sidecar vt", pid: 9, cpuSeconds: 2.5, peakBytes: 50 * 1024 }];
  assert.deepEqual(firstDragFigures(before, after), {
    processes: [
      { role: "host", pid: 7, cpuSeconds: 0.25, peakBeforeKb: 100, peakAfterKb: 140 },
      { role: "sidecar vt", pid: 9, cpuSeconds: 0.5, peakBeforeKb: 50, peakAfterKb: 50 },
    ],
    cpuSeconds: 0.75, peakBeforeKb: 150, peakAfterKb: 190,
  });
  assert.throws(() => firstDragFigures(before, after.slice(0, 1)),
    new Error("sidecar vt (pid 9) was read before the first drag and not after it"));
  assert.throws(() => firstDragFigures(before.slice(0, 1), after),
    new Error("sidecar vt (pid 9) was read after the first drag and not before it"));
  assert.throws(() => firstDragFigures(before, [{ ...after[0], cpuSeconds: 0.5 }, after[1]]),
    new Error("host (pid 7) reports a CPU time of 0.5 s after the first drag, less than 1 s before it"));
});

const ns = (micros) => String(9_000_000_000n + BigInt(micros) * 1000n);
/** The U7 records of a third drag of window w1: two requested frames and two steps. */
const THIRD_DRAG = [
  { seq: 1, event: "host.frame.step", fields: { window: "w1", kind: "selector", callback: "mouseDragged:", entry_ns: ns(0), return_ns: ns(1500), forwarded: 2, wait_ns: "0" } },
  { seq: 2, event: "host.frame.record", fields: { window: "w1", start_ns: ns(1000), request_ns: ns(4000), drawable_wait_ns: "1000000" } },
  { seq: 3, event: "host.frame.step", fields: { window: "w1", kind: "block", callback: "present", entry_ns: ns(4100), return_ns: ns(4300), forwarded: 0, wait_ns: "0" } },
  { seq: 4, event: "host.frame.record", fields: { window: "w1", start_ns: ns(9000), request_ns: ns(13000), drawable_wait_ns: "0" } },
];

test("the B3 values of the view drag are the first-drag figures in the state 0 and the U7 figures of the third drag in the state frame-records",
  { timeout: 5000 }, () => {
    const firstDrag = { cpuSeconds: 0.75, peakBeforeKb: 150, peakAfterKb: 190 };
    const recorded = { result: {}, records: THIRD_DRAG };
    const zero = viewDragB3Values("0", { firstDrag, recorded, gcLoop: false });
    assert.deepEqual(zero, { peakBeforeDragKb: 150, peakAfterDragKb: 190, dragCpuSeconds: 0.75 });
    const frames = viewDragB3Values("frame-records", { firstDrag, recorded, gcLoop: false });
    assert.deepEqual(frames, { dragFrameP90Ms: 4, dragStepP90Ms: 1.5, dragFirstFrameMs: 3 });
    assert.deepEqual(Object.keys(zero), B3_MEASUREMENTS["view-drag"]["0"].filter((key) => key !== "verdict"));
    assert.deepEqual(Object.keys(frames), B3_MEASUREMENTS["view-drag"]["frame-records"]);
    assert.deepEqual(viewDragB3Values("frame-records", { firstDrag, recorded, gcLoop: true }), { dragFrameP90Ms: 4, dragStepP90Ms: 1.5 });
    assert.throws(() => viewDragB3Values("frame-records", { firstDrag, recorded: null, gcLoop: false }),
      new Error("the state frame-records writes the U7 records of the third drag, which a window with a main page does not have"));
    assert.throws(() => viewDragB3Values(0, { firstDrag, recorded, gcLoop: false }),
      new Error("the view drag measures in the states 0 and frame-records of B3_MEASUREMENTS, not 0"));
  });

test("the processes of the drag are the rows of the application with the CPU time of each and its peak footprint", { timeout: 5000 }, async () => {
  const commands = [];
  const run = async (command, args) => {
    commands.push(`${command} ${args.join(" ")}`);
    if (command === "ps") return { status: 0, stdout: "  7 0:01.50\n  9 1:00.25\n 11 0:00.10\n", stderr: "" };
    const pid = Number(args[1]);
    return { status: 0, stdout: `    phys_footprint: ${pid * 1000} B\n    phys_footprint_peak: ${pid * 2048} B\n`, stderr: "" };
  };
  const rows = async () => ({ rows: [{ role: "host", pid: 7, attribution: "config-dir argument" }, { role: "sidecar files", pid: 9 }], errors: [] });
  assert.deepEqual(await dragProcesses({ rows, run }), [
    { role: "host", pid: 7, cpuSeconds: 1.5, peakBytes: 7 * 2048 },
    { role: "sidecar files", pid: 9, cpuSeconds: 60.25, peakBytes: 9 * 2048 },
  ]);
  assert.deepEqual(commands, ["ps -axo pid=,time=", "footprint -p 7 -f bytes", "footprint -p 9 -f bytes"]);
  await assert.rejects(dragProcesses({ rows: async () => ({ rows: [], errors: ["w1: the page process 4 has ended"] }), run }),
    new Error("the processes of the application cannot be read: w1: the page process 4 has ended"));
  await assert.rejects(dragProcesses({ rows: async () => ({ rows: [{ role: "webkit gpu", pid: 12 }], errors: [] }), run }),
    new Error("webkit gpu (pid 12) has no CPU time in ps -axo pid=,time="));
});
