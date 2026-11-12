// The maximise and restore gesture of the resize window check (e2e/resize.test.mjs) and of its benchmark
// (e2e/benchmark/resize-catch-up.test.mjs). Each change is recorded; the recording is the evidence of the change. After the captured
// maximise and restore the benchmark runs a maximise and restore without capture under the trace state of the frame records and reads
// their U7 records (gesture-records.mjs).
import { FRAME_RECORDS } from "../../../scripts/measure-trace.mjs";
import { B3_SETTINGS } from "../measurements.mjs";
import { fixtureSettings } from "./b3-run.mjs";
import { gestureB3Values } from "./gesture-records.mjs";
import { fresh } from "../../fixture.mjs";

/** Time (ms) added after the display time so that the recording also covers the interval in which the layout follows. */
const SETTLE = 100;

/** Distance between the right edge of the window and the rightmost surface. The layout keeps this distance regardless of the window size. */
const right = (w) => Math.max(...w.surfaces.filter((x) => x.visible).map((x) => x.frame.x + x.frame.width));

const margin = (w) => w.content.width - right(w);

/**
 * Records the change that resizes the window until the layout at the new size is displayed: the window reaches the size of `sized`
 * and the surfaces keep their distance to the right edge of the window. Returns `{displayed, frames, missed, late, layouts}` of the
 * recording, which is the evidence of the change.
 */
async function record(s, change, sized) {
  const kept = margin(await s.get("host.window"));
  const recording = await s.record();
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
  const { frames, layouts, missed, late } = await recording.stop({ after: displayed ? displayed + SETTLE : 0 });
  if (failure) throw failure;
  return { displayed, frames, missed, late, layouts };
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
 * Maximises the window of `s` and restores it, recording each change. `judge(gesture, recorded)` runs after each recorded change
 * with `{displayed, frames, missed, late, layouts}` (`missed` and `late`: the stills that the recording did not write and those that
 * it requested late) and may throw. `started()` runs after the preparation, right before the first gesture. The window is restored
 * when the check ends and it was maximised. Returns the recorded gestures and pageProcess of host.window.
 */
export async function recordMaximiseAndRestore(s, judge = () => {}, { started = async () => {} } = {}) {
  // The settings of the state captured, whose performance trace records the view joins of each layout transaction and whose frame gate
  // records the page layout phases (F292-41).
  await fresh(s, {
    ...fixtureSettings(B3_SETTINGS["resize-catch-up"].captured),
    reads: ["host.window.event", "host.trace.view.presentation-join", "host.trace.view.presentation-abandoned", "host.stall",
      "workbench.trace.layout"],
  });
  const { pageProcess } = await s.get("host.window");
  const { maximise, restore, restored } = await maximiseAndRestore(s);
  await started();
  const grown = await record(s, maximise.change, maximise.sized);
  judge("maximising", grown);
  const shrunk = await record(s, restore.change, restore.sized);
  restored();
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
