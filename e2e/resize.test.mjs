// Records the maximize and restore of the window, checks that the app layout matches the window size after the change ends, and reports
// the number of frames in which the layout was later than the window during the change.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open, RECORDING } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { CATCH_UP, frameEvidence, judgeFrames, lagStages, measureFrame, writeEvidence } from "./resize-frames.mjs";

/** Time (ms) added after the display time so that the recording also covers the interval in which the layout follows. */
const SETTLE = 100;

/** Records the change that resizes the window and measures the frames until the layout is displayed at the new size. */
const right = (w) => Math.max(...w.surfaces.filter((x) => x.visible).map((x) => x.frame.x + x.frame.width));

/** Distance between the right edge of the window and the rightmost surface. The layout keeps this distance regardless of the window size. */
const margin = (w) => w.content.width - right(w);

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
 * Checks that the layout of the last displayed frame after the change ends matches the window size, and reports the number of frames in which the layout
 * was later than the window during the change. The window frame and the WebKit content are displayed separately (WebKit/WebKit#72971,
 * tauri-apps/tao#1207), so late frames during the change remain only as a measured value.
 */
function assertSettled(t, { displayed, measured, stages }, label) {
  assert.ok(measured.length > 1, `${label}: only ${measured.length} frames were recorded`);
  const [first] = measured;
  const last = measured.at(-1);
  const tail = measured.slice(-5).map((m) =>
    `${(m.time - first.time).toFixed(0)}ms ${m.window.width.toFixed(0)}×${m.window.height.toFixed(0)} gap ${m.gap.x.toFixed(0)},${m.gap.y.toFixed(0)}`);
  const shown = `presented for display at ${(displayed - first.time).toFixed(0)}ms`;
  assert.ok(Math.abs(last.window.width - first.window.width) > 100,
    `${label}: the recording did not include the resized window (${first.window.width} → ${last.window.width}; ` +
    `${shown}; last frames ${tail.join(", ")})`);
  const { behind, took } = judgeFrames(measured);
  t.diagnostic(`${label}: ${behind.filter(Boolean).length} of ${measured.length} frames show the layout behind the window, the last at ${took.toFixed(0)}ms`);
  assert.ok(took <= CATCH_UP, `${label}: the layout stayed behind the window for ${took.toFixed(0)}ms, more than ${CATCH_UP}ms ` +
    `(${shown}; last frames ${tail.join(", ")}; stages ${JSON.stringify(stages)})`);
  assert.ok(!behind.at(-1), `${label}: the settled frame shows the layout behind the window ` +
    `(window ${last.window.width.toFixed(0)}×${last.window.height.toFixed(0)}, gap ${last.gap.x.toFixed(0)},${last.gap.y.toFixed(0)}, ` +
    `base gap ${first.gap.x.toFixed(0)},${first.gap.y.toFixed(0)}; ${shown}; last frames ${tail.join(", ")})`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising and restoring settle with the layout at the window size`, RECORDING, async (t) => {
    const s = await open(t, app);
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
    assertSettled(t, grown, "maximising");

    const shrunk = await record(s, "restoring", () => s.run("host.window.maximize", { on: false }),
      (w) => same(w.frame, before));
    maximised = false;
    assertSettled(t, shrunk, "restoring");
  });
}
