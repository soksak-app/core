// The maximise and restore gesture of the resize window check (e2e/resize.test.mjs) and of its benchmark
// (e2e/benchmark/resize-catch-up.test.mjs). Both record the same frames; the check judges the behaviour and the benchmark judges the limit.
import { rmSync } from "node:fs";

import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "../../fixture.mjs";
import { frameEvidence, lagStages, measureFrame, writeEvidence } from "../../resize-frames.mjs";

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
 * Records the change that resizes the window and measures the frames until the layout is displayed at the new size.
 * The recording and the evidence are kept whether the change passes or fails.
 */
async function record(s, gesture, change, sized) {
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
    const measured = frames(directory).map((path) => measureFrame(readFrame(path)));
    // The stages name where the time of a late layout went: the resize event, the layout transaction that caught up, the view
    // join that held its commit, and the host stall records of the gesture.
    await s.flushLog();
    const stages = lagStages({ measured, layouts, events: readEvents(s.app.configDir, offsets).events });
    // The measured frames of the gesture are kept in the run folder whether the change passes or fails.
    writeEvidence(process.env.SOKSAK_RUN_FOLDER, s.app.name, gesture, frameEvidence({ gesture, displayed, measured, layouts, stages }));
    if (failure) throw failure;
    return { displayed, measured, stages };
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
 * Maximises the window of `s` and restores it, recording each change. `judge(gesture, recorded)` runs after each recorded change
 * with `{displayed, measured, stages}` and may throw. The window is restored when the check ends and it was maximised.
 */
export async function recordMaximiseAndRestore(s, judge = () => {}) {
  // The performance trace records the view joins of each layout transaction and the frame gate the page layout phases, so
  // the stages of a late layout are named from the records (F292-41).
  await fresh(s, {
    performanceTrace: true,
    log: { lifecycle: "debug", call: "debug", frame: "debug" },
    reads: ["host.window.event", "host.trace.view.presentation-join", "host.trace.view.presentation-abandoned", "host.stall",
      "page.trace.layout"],
  });
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

  const grown = await record(s, "maximising", async () => {
    maximised = true;
    await s.run("host.window.maximize", { on: true });
  }, (w) => same(w.frame, screen.visible));
  judge("maximising", grown);

  const shrunk = await record(s, "restoring", () => s.run("host.window.maximize", { on: false }),
    (w) => same(w.frame, before));
  maximised = false;
  judge("restoring", shrunk);
  return { grown, shrunk };
}
