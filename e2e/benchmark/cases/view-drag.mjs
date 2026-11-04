// The view drag benchmark of B3 (docs/plans/mygo-host.md, S5 and S16; e2e/benchmark/view-drag.test.mjs). It runs, in order, a drag
// without capture under the default policy through `diagnostics.drag` with `native: true` and the plan of the captured drag, the
// captured drag under the default policy and, after `frames` of host.window has not changed for 3 seconds (3 seconds on a window whose
// `frames` is null), a drag without capture under the policy that stores the class `frame` at `debug` (FRAME_RECORDS of
// scripts/measure-trace.mjs), whose U7 records it reads on a window without a main page. It reads the CPU time and the peak footprint
// of each process of the application before and after the first drag. SOKSAK_ACCESSIBILITY=1 reads the elements of the window through
// the accessibility API before the drags; SOKSAK_FLOOR=1 drags a card whose view page is a plain page without plugin code;
// SOKSAK_GC_LOOP=1 turns `diagnostics.gc.loop` on before the third drag and off after it, on a window whose host.window reports
// pageProcess null. This module holds the order of the steps and the figures; the benchmark gives the steps of a running application.
import { readFootprint } from "../../../scripts/footprints.mjs";
import { readCpuSeconds } from "../../../scripts/measure-app-usage.mjs";
import { FRAME_RECORDS } from "../../../scripts/measure-trace.mjs";
import { gestureB3Values } from "./gesture-records.mjs";
import { TERMINAL_DRAG_PLAN } from "./terminal.mjs";

/** The first drag: the plan of the captured drag, delivered as native input of the primary button without capture. */
export const NATIVE_DRAG_PLAN = Object.freeze({ ...TERMINAL_DRAG_PLAN, native: true });

/** Reads a switch of the view drag: unset is off and 1 is on; any other value is an error that names it. */
function option(env, name) {
  const value = env[name];
  if (value === undefined) return false;
  if (value === "1") return true;
  throw new Error(`${name} must be unset or 1, not ${JSON.stringify(value)}`);
}

/** The switches of the view drag from the environment: SOKSAK_ACCESSIBILITY, SOKSAK_FLOOR and SOKSAK_GC_LOOP. */
export function viewDragOptions(env) {
  return { accessibility: option(env, "SOKSAK_ACCESSIBILITY"), floor: option(env, "SOKSAK_FLOOR"), gcLoop: option(env, "SOKSAK_GC_LOOP") };
}

/**
 * Runs `cleanup()` after `action()` whether it fails or not and returns the result of `action`. A failure of either is thrown; when both
 * fail, an AggregateError holds both and names `what` and `cleaning`.
 */
async function withCleanup(action, cleanup, what, cleaning) {
  let result;
  let failure;
  try {
    result = await action();
  } catch (error) {
    failure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], `${what} failed (${failure.message}) and ${cleaning} failed (${error.message})`);
    throw error;
  }
  if (failure) throw failure;
  return result;
}

/**
 * Runs the drags of the view drag in the order of B3 with `steps` of a running application:
 *   readElements()        the elements of the window through the accessibility API (options.accessibility)
 *   readProcesses()       the processes of the application, each { role, pid, cpuSeconds, peakBytes }
 *   nativeDrag()          the first drag (NATIVE_DRAG_PLAN) under the default policy
 *   capturedDrag()        the captured drag under the default policy
 *   untilFramesQuiet()    waits until frames of host.window has not changed for 3 seconds, or 3 seconds when frames is null
 *   frameRecords()        sets the trace state FRAME_RECORDS
 *   gcLoop(on)            turns diagnostics.gc.loop on or off (options.gcLoop)
 *   uncapturedDrag()      the third drag, without capture
 *   record(gesture)       runs the gesture and reads its U7 records (recordGesture of gesture-records.mjs) on a window without a
 *                         main page, or runs it and returns null on another window
 *   conditions(state)     reads the B3 conditions of the window now (b3Conditions of b3-run.mjs) for the state `state` of
 *                         B3_MEASUREMENTS: "0" at the start of its interval, before the first drag, and FRAME_RECORDS after
 *                         frameRecords
 *   firstDragRead(figures) receives the figures of the first drag (firstDragFigures) as soon as they are read
 * `pageProcess` is pageProcess of host.window. The settings that the steps change return when the check ends (keepCommonSettings of
 * @soksak/window-check), so the trace state of the third drag is not set back here; diagnostics.gc.loop is not a setting and is turned
 * off after the third drag whether it fails or not. Returns the elements, the captured drag and the record of the third drag.
 */
export async function runViewDrag({ options, pageProcess, steps }) {
  if (options.gcLoop && pageProcess !== null) {
    throw new Error(`GC_LOOP=1 turns diagnostics.gc.loop on in the mygo host, a window whose host.window reports pageProcess null, not ${pageProcess}`);
  }
  const elements = options.accessibility ? await steps.readElements() : null;
  await steps.conditions("0");
  const before = await steps.readProcesses();
  await steps.nativeDrag();
  const after = await steps.readProcesses();
  await steps.firstDragRead(firstDragFigures(before, after));
  const captured = await steps.capturedDrag();
  await steps.untilFramesQuiet();
  await steps.frameRecords();
  await steps.conditions(FRAME_RECORDS);
  const recorded = await steps.record(async () => {
    if (!options.gcLoop) return steps.uncapturedDrag();
    await steps.gcLoop(true);
    return withCleanup(() => steps.uncapturedDrag(), () => steps.gcLoop(false), "the third drag", "turning diagnostics.gc.loop off");
  });
  return { elements, captured, recorded };
}

/**
 * The processes of the application for the figures of the first drag, each { role, pid, cpuSeconds, peakBytes }. `rows()` resolves to
 * the rows of the application and its window (windowApplicationRows of scripts/measure-app-usage.mjs), whose errors fail the reading;
 * the CPU seconds of every process are read once with readCpuSeconds and then the peak footprint of each row with readFootprint, both
 * through `run`, the executor of scripts/measure-app-usage.mjs.
 */
export async function dragProcesses({ rows, run }) {
  const read = await rows();
  if (read.errors.length > 0) throw new Error(`the processes of the application cannot be read: ${read.errors.join("; ")}`);
  const cpu = await readCpuSeconds(run);
  const processes = [];
  for (const { role, pid } of read.rows) {
    if (!cpu.has(pid)) throw new Error(`${role} (pid ${pid}) has no CPU time in ps -axo pid=,time=`);
    processes.push({ role, pid, cpuSeconds: cpu.get(pid), peakBytes: (await readFootprint(pid, run)).peakBytes });
  }
  return processes;
}

const kilobytes = (bytes) => Math.round(bytes / 1024);
const where = ({ role, pid }) => `${role} (pid ${pid})`;

/**
 * The figures of the first drag from the processes read before and after it: for each process the CPU time that it used over the drag
 * and its peak footprint before and after it in KB, and their sums. A process read only once, or whose CPU time went back, is an error.
 */
export function firstDragFigures(before, after) {
  for (const row of after) {
    if (!before.some(({ pid }) => pid === row.pid)) throw new Error(`${where(row)} was read after the first drag and not before it`);
  }
  const processes = before.map((row) => {
    const later = after.find(({ pid }) => pid === row.pid);
    if (later === undefined) throw new Error(`${where(row)} was read before the first drag and not after it`);
    if (later.cpuSeconds < row.cpuSeconds) {
      throw new Error(`${where(row)} reports a CPU time of ${later.cpuSeconds} s after the first drag, less than ${row.cpuSeconds} s before it`);
    }
    return { role: row.role, pid: row.pid, cpuSeconds: later.cpuSeconds - row.cpuSeconds,
      peakBeforeKb: kilobytes(row.peakBytes), peakAfterKb: kilobytes(later.peakBytes) };
  });
  const sum = (name) => processes.reduce((total, row) => total + row[name], 0);
  return { processes, cpuSeconds: sum("cpuSeconds"), peakBeforeKb: sum("peakBeforeKb"), peakAfterKb: sum("peakAfterKb") };
}

/**
 * The B3 values of the view drag in the state `state` of B3_MEASUREMENTS of e2e/benchmark/measurements.mjs (the verdict is written by
 * withB3Out of b3-run.mjs). In the state "0": peakBeforeDragKb and peakAfterDragKb, the sums of the peak footprints before and after
 * the first drag, and dragCpuSeconds, the CPU seconds of the application over it. In the state FRAME_RECORDS: the U7
 * figures of the third drag (gestureB3Values of gesture-records.mjs), with the time of its first frame unless diagnostics.gc.loop ran
 * through it. A window with a main page has no U7 records, so its third drag gives no value of the frame records.
 */
export function viewDragB3Values(state, { firstDrag, recorded, gcLoop }) {
  if (state === "0") return { peakBeforeDragKb: firstDrag.peakBeforeKb, peakAfterDragKb: firstDrag.peakAfterKb, dragCpuSeconds: firstDrag.cpuSeconds };
  if (state !== FRAME_RECORDS) throw new Error(`the view drag measures in the states 0 and ${FRAME_RECORDS} of B3_MEASUREMENTS, not ${JSON.stringify(state)}`);
  if (recorded === null) {
    throw new Error(`the state ${FRAME_RECORDS} writes the U7 records of the third drag, which a window with a main page does not have`);
  }
  return gestureB3Values("drag", recorded.records, { firstFrame: !gcLoop });
}
