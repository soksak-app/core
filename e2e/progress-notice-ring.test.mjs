// The progress notice ring turns in a running window (docs/spec/notifications.md, the progress kind: a turning ring). The check adds a
// progress notice to the plugin of the start tab with the declared command core.notices.add, opens the notice center, and keeps only
// the progress entries with core.notices.filter, so the first core.notices.entry is the progress notice. It sets the reduced motion
// override of the application with diagnostics.motion, records the frames that the window delivers while the ring is drawn
// (diagnostics.capture.start/stop, paced by the refresh rate that the recorder reads), and compares the pixels of the leading square of
// the ring element core.notices.ring (the mark of the progress entry), from one frame to the next. With the override true the ring
// stays the same; with the override false it turns. The check changes no operating system preference, and it restores the platform value
// when it ends.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
import { requireNoLostStills } from "@soksak/window-check/stills.mjs";
import { pixelAt, readFrame } from "./benchmark/cases/frame-pixels.mjs";
import { fresh, START_PLUGIN } from "./fixture.mjs";

const RECORDED_STILLS = 30;
const GRID = 6;
const TITLE = "progress notice ring check";

/** The pixels of a GRID x GRID grid of window points over the leading square of `rect` in `frame`, as one string. */
function ringSamples(frame, rect) {
  const side = rect.height;
  const values = [];
  for (let row = 0; row < GRID; row++) {
    for (let column = 0; column < GRID; column++) {
      const point = { x: rect.x + ((column + 0.5) * side) / GRID, y: rect.y + ((row + 0.5) * side) / GRID };
      values.push(pixelAt(frame, point).join(","));
    }
  }
  return values.join(";");
}

// Each application runs both branches: the reduced motion override true, where the ring must not change, and false, where it must.
for (const app of Object.values(APPS)) for (const reduced of [true, false]) {
  test(`${app.name}: the progress notice ring ${reduced ? "does not change" : "turns"} with the reduced motion override ${reduced}`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await s.request("diagnostics.motion", { reduce: reduced });
    try {
      const wasOpen = (await s.get("core.notices")).open;
      if (!wasOpen) await s.run("core.notices.toggle");
      const id = await s.run("core.notices.add", { plugin: START_PLUGIN, kind: "progress", title: TITLE });
      try {
        await s.until("core.notices", (value) => value.entries.some((entry) => entry.id === id), "the progress notice is not listed");
        await s.run("core.notices.filter", { filter: "progress" });
        await s.until("core.notices", (value) => value.filter === "progress", "the notice center did not show the progress filter");
        const rect = await s.rect("core.notices.ring", 0);
        assert.ok(rect.height > 0 && rect.width > 0, `the progress ring has no drawn size: ${JSON.stringify(rect)}`);

        // Each still is taken at one refresh of the window, so the recording paces by the display and not by a fixed frame time.
        const recording = await s.record({ frames: RECORDED_STILLS });
        // A stop without `after` requests only the stills whose planned time has already come, so the check waits on the display clock
        // until the stills of the recording are all planned, then stops after its first displayed time. The length of a still is the
        // refresh of the window that the host reports, and a stop after a time beyond the last planned still fails.
        const { refreshRate } = await s.get("host.window");
        const gap = 1000 / refreshRate;
        const start = (await s.presented()).displayed;
        let displayed = start;
        while (displayed - start < RECORDED_STILLS * gap) displayed = (await s.presented()).displayed;
        const stopped = await recording.stop({ after: start });
        requireNoLostStills(recording.judge(), "the recording");
        const files = frames(stopped.frames);
        assert.ok(files.length >= 2, `the recording holds ${files.length} frames, fewer than 2`);
        const samples = files.map((file) => ringSamples(readFrame(file), rect));
        const turns = samples.slice(1).filter((value, index) => value !== samples[index]).length;
        recording.keep("progress-ring", { rect, samples, reduced, turns });
        t.diagnostic(`${app.name}: ${files.length} frames, ${turns} changes of the progress ring, reduced motion override ${reduced}`);
        if (reduced) {
          assert.equal(turns, 0, `the progress ring changed in ${turns} frames under the reduced motion override`);
        } else {
          assert.ok(turns > 0, `the progress ring did not change across the ${files.length} delivered frames`);
        }
      } finally {
        await s.run("core.notices.done", { id, kind: "success", title: TITLE });
        await s.run("core.notices.filter", { filter: "all" });
        if (!wasOpen) await s.run("core.notices.toggle");
      }
    } finally {
      await s.request("diagnostics.motion", { reduce: null });
    }
  });
}
