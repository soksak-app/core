// The maximise and restore gesture of the resize window check (e2e/resize.test.mjs) and of its benchmark
// (e2e/benchmark/resize-catch-up.test.mjs). Both record the same frames; the check judges the behaviour and the benchmark judges the limit.
// On a window whose host.window reports pageProcess null the benchmark also opens the floor page fixture view in the focused card and
// judges each recorded frame with the geometry rule of the view drag (dragGeometryFrame of floor-page.mjs, evaluateGeometryFrames of
// @soksak/window-check/view-metrics.mjs), and after
// the captured maximise and restore it runs a maximise and restore without capture under the trace state of the frame records and reads
// their U7 records (gesture-records.mjs).
import { rmSync } from "node:fs";

import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { evaluateGeometryFrames } from "@soksak/window-check/view-metrics.mjs";
import { FRAME_RECORDS } from "../../../scripts/measure-trace.mjs";
import { B3_SETTINGS } from "../measurements.mjs";
import { fixtureSettings } from "./b3-run.mjs";
import { gestureB3Values } from "./gesture-records.mjs";
import { fresh } from "../../fixture.mjs";
import { frameEvidence, lagStages, measureFrame, writeEvidence } from "../../resize-frames.mjs";
import { effectiveCardCornerRadiusPt } from "../../view-frame-geometry.mjs";
import { dragGeometryFrame, floorSlotInsets, measureFloorLayoutFrame, openFloorPage } from "./floor-page.mjs";

/**
 * Time (ms) from the first recorded frame to the last frame in which the layout is behind the window, that the layout may take
 * (docs/spec/native-surfaces.md#performance-targets).
 */
export const CATCH_UP_LIMIT_MS = 150;

/** Time (ms) added after the display time so that the recording also covers the interval in which the layout follows. */
const SETTLE = 100;

/** Distance between the right edge of the window and the rightmost surface. The layout keeps this distance regardless of the window size. */
const right = (w) => Math.max(...w.surfaces.filter((x) => x.visible).map((x) => x.frame.x + x.frame.width));

const margin = (w) => w.content.width - right(w);

/**
 * Records the change that resizes the window and measures the frames until the layout is displayed at the new size; with `geometry`
 * ({cornerRadiusPt, slotInsetsPt}) it also judges each recorded frame with the geometry rule of the view drag (resizeGeometry).
 * The recording and the evidence are kept whether the change passes or fails.
 */
async function record(s, gesture, change, sized, geometry) {
  const kept = margin(await s.get("host.window"));
  const offsets = currentEventOffsets(s.app.configDir);
  const { frames: directory } = await s.request("diagnostics.capture.start");
  // The recording stores frames of the window size at up to 60 per second, so it is deleted right after the measurement.
  try {
    // The recording covers the screen up to this display time. A screen that the app committed is displayed after the display wait ends.
    let displayed = 0;
    let failure;
    try {
      await change();
      // Waits until the window reaches the new size, the surface moves to the layout of that size and that layout is displayed.
      await s.until("host.window", (w) => sized(w) && Math.abs(margin(w) - kept) < 1,
        "the surfaces did not follow the window");
      ({ displayed } = await s.presented());
    } catch (error) {
      failure = error;
    }
    // Covers the interval in which the layout follows after the window reaches the new size. The recording is stopped even when the change failed.
    const { layouts } = await s.request("diagnostics.capture.stop", { after: displayed ? displayed + SETTLE : 0 });
    const decoded = frames(directory).map(readFrame);
    const measured = decoded.map(measureFrame);
    let judged = null;
    if (geometry !== null) {
      try {
        judged = resizeGeometry(gesture, decoded, geometry);
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], `${gesture} failed (${failure.message}) and its frames have no geometry (${error.message})`) : error;
      }
    }
    // The stages name where the time of a late layout went: the resize event, the layout transaction that caught up, the view
    // join that held its commit, and the host stall records of the gesture.
    await s.flushLog();
    const stages = lagStages({ measured, layouts, events: readEvents(s.app.configDir, offsets).events });
    // The measured frames of the gesture are kept in the run folder whether the change passes or fails.
    writeEvidence(process.env.SOKSAK_RUN_FOLDER, s.app.name, gesture, frameEvidence({ gesture, displayed, measured, layouts, stages }));
    if (failure) throw failure;
    return { displayed, measured, stages, geometry: judged };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The geometry rule of the view drag over the recorded frames `decoded` of `gesture`: the card and the rectangle of the floor page view
 * in each frame (`measure`, measureFloorLayoutFrame of floor-page.mjs, with the corner radius of the cards), against the slot that the
 * insets `slotInsetsPt` of the view declare in the card (dragGeometryFrame of floor-page.mjs, evaluateGeometryFrames of
 * @soksak/window-check/view-metrics.mjs). A frame without the floor page geometry is an error that names it.
 */
export function resizeGeometry(gesture, decoded, { cornerRadiusPt, slotInsetsPt, measure = measureFloorLayoutFrame }) {
  const rows = decoded.map((frame, frameIndex) => {
    let measured;
    try {
      measured = measure(frame, { cornerRadiusPt });
    } catch (error) {
      throw new Error(`${gesture}: recorded frame ${frameIndex} has no floor page geometry: ${error.message}`, { cause: error });
    }
    return dragGeometryFrame(frameIndex, measured, slotInsetsPt);
  });
  return evaluateGeometryFrames(rows, `${gesture}.geometryFrames`);
}

/** Fails when the geometry rule of `gesture` (resizeGeometry) did not hold in every recorded frame. */
export function assertResizeGeometry(gesture, geometry) {
  if (!geometry.passed) {
    throw new Error(`${gesture}: the rectangle of the floor page view is ${geometry.maxErrorPt} pt from its card slot in a recorded frame, more than ${geometry.limitPt} pt`);
  }
}

/**
 * Fails when the layout stayed behind the window for `took` ms (the `judgeFrames` time of a gesture), which is more than CATCH_UP_LIMIT_MS.
 * A time that is not a finite nonnegative number is rejected rather than compared.
 */
export function assertCatchUpWithinBound(took, label) {
  if (!Number.isFinite(took) || took < 0) {
    throw new TypeError(`${label}: the catch-up time must be a finite nonnegative number of ms, found ${took}`);
  }
  if (took > CATCH_UP_LIMIT_MS) {
    throw new Error(`${label}: the layout stayed behind the window for ${took.toFixed(0)}ms, more than ${CATCH_UP_LIMIT_MS}ms`);
  }
}

/**
 * The maximise and the restore of the window of `s`: each a change and the predicate on host.window of the size that it reaches, and
 * `restored()`, which a caller runs once the window reached its size again. The window is restored when the check ends while it was
 * maximised and not restored.
 */
async function maximiseAndRestore(s) {
  const before = (await s.get("host.window")).frame;
  // The usable area of the screen that holds the window is the frame of the maximized window.
  const screen = (await s.get("host.screens")).find((x) => before.x >= x.x && before.x < x.x + x.width
    && before.y >= x.y && before.y < x.y + x.height);
  const same = (a, b) => ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) < 1);
  let maximised = false;
  s.cleanup(async () => {
    if (!maximised) return;
    await s.run("host.window.maximize", { on: false });
    await s.until("host.window", (w) => w.frame.width === before.width && w.frame.height === before.height,
      "the window did not return to its size");
    await s.presented();
  });
  return {
    maximise: {
      change: async () => {
        maximised = true;
        await s.run("host.window.maximize", { on: true });
      },
      sized: (w) => same(w.frame, screen.visible),
    },
    restore: {
      change: () => s.run("host.window.maximize", { on: false }),
      sized: (w) => same(w.frame, before),
    },
    restored: () => { maximised = false; },
  };
}

/**
 * The geometry of the window of `s` for the geometry rule: the floor page view, which draws the measurement colour over its frame, opens
 * as the active tab of the focused card, and the corner radius of the cards and the insets of the slot of the view in its card are read.
 */
async function floorGeometry(s) {
  const { surface, card } = await openFloorPage(s);
  await s.presented();
  const { values } = await s.get("core.settings");
  return { cornerRadiusPt: effectiveCardCornerRadiusPt(values), slotInsetsPt: await floorSlotInsets(s, card, surface) };
}

/**
 * Maximises the window of `s` and restores it, recording each change. `judge(gesture, recorded)` runs after each recorded change
 * with `{displayed, measured, stages, geometry}` and may throw. With `geometry` and on a window whose host.window reports pageProcess
 * null, each recorded frame is also judged with the geometry rule of the view drag (resizeGeometry, assertResizeGeometry); the
 * geometry of a gesture is null otherwise. `started()` runs after the preparation, right before the first gesture. The window is
 * restored when the check ends and it was maximised. Returns the recorded gestures and pageProcess of host.window.
 */
export async function recordMaximiseAndRestore(s, judge = () => {}, { geometry = false, started = async () => {} } = {}) {
  // The settings of the state captured, whose performance trace records the view joins of each layout transaction and whose frame gate
  // records the page layout phases, so the stages of a late layout are named from the records (F292-41).
  await fresh(s, {
    ...fixtureSettings(B3_SETTINGS["resize-catch-up"].captured),
    reads: ["host.window.event", "host.trace.view.presentation-join", "host.trace.view.presentation-abandoned", "host.stall",
      "workbench.trace.layout"],
  });
  const { pageProcess } = await s.get("host.window");
  const frameGeometry = geometry && pageProcess === null ? await floorGeometry(s) : null;
  const { maximise, restore, restored } = await maximiseAndRestore(s);
  await started();
  const grown = await record(s, "maximising", maximise.change, maximise.sized, frameGeometry);
  if (grown.geometry !== null) assertResizeGeometry("maximising", grown.geometry);
  judge("maximising", grown);
  const shrunk = await record(s, "restoring", restore.change, restore.sized, frameGeometry);
  restored();
  if (shrunk.geometry !== null) assertResizeGeometry("restoring", shrunk.geometry);
  judge("restoring", shrunk);
  return { grown, shrunk, pageProcess };
}

/** Runs `change` without capture and waits until the window reaches the size of `sized`, the layout follows and it is displayed. */
async function uncaptured(s, change, sized) {
  const kept = margin(await s.get("host.window"));
  await change();
  await s.until("host.window", (w) => sized(w) && Math.abs(margin(w) - kept) < 1, "the surfaces did not follow the window");
  return s.presented();
}

/**
 * The maximise and restore without capture of a window without a main page, after the captured ones: `frameRecords()` sets the trace
 * state of the frame records (FRAME_RECORDS of scripts/measure-trace.mjs), and `record(gesture)` runs `maximise()` and then `restore()`
 * and reads the U7 records of each (recordGesture of gesture-records.mjs). Returns the record of each gesture.
 */
export async function uncapturedResize({ frameRecords, record: recordOf, maximise, restore }) {
  await frameRecords();
  return { maximise: await recordOf(maximise), restore: await recordOf(restore) };
}

/** The steps of uncapturedResize on the window of `s`: its maximise and its restore without capture. */
export async function uncapturedResizeGestures(s) {
  const { maximise, restore, restored } = await maximiseAndRestore(s);
  return {
    maximise: () => uncaptured(s, maximise.change, maximise.sized),
    restore: async () => {
      const presented = await uncaptured(s, restore.change, restore.sized);
      restored();
      return presented;
    },
  };
}

/**
 * The B3 values of the resize catch-up in the state `state` of B3_MEASUREMENTS of e2e/benchmark/measurements.mjs (the verdict is written
 * by withB3Out of b3-run.mjs): none besides the verdict in the state captured, and in the state FRAME_RECORDS the U7 figures of the
 * maximise without capture (gestureB3Values of gesture-records.mjs). A window with a main page has no U7 records.
 */
export function resizeB3Values(state, { recorded }) {
  if (state === "captured") return {};
  if (state !== FRAME_RECORDS) {
    throw new Error(`the resize catch-up measures in the states captured and ${FRAME_RECORDS} of B3_MEASUREMENTS, not ${JSON.stringify(state)}`);
  }
  if (recorded === null) {
    throw new Error(`the state ${FRAME_RECORDS} writes the U7 records of the maximise without capture, which a window with a main page does not have`);
  }
  return gestureB3Values("maximise", recorded.maximise.records, { firstFrame: false });
}
