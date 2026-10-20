// Measures in every frame recorded while the frame text scale changes that the window buttons are at the center of the first row
// (docs/spec/native-surfaces.md#title-bar-height). Records the time while the scale rises one step at a time from 1 to 3 and comes back down to 1, and the time
// while this window reads again after another window changes the scale. The buttons and the first row are measured in the pixels of the frame
// (titlebar-measurement.mjs). A value in the DOM does not tell the screen that the frame showed.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, coveredBy, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { missingPoses } from "./card-panel-checks.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { TOLERANCE, measureTitlebar, misaligned, rowHeight } from "./titlebar-measurement.mjs";

// The scale steps that rise from 1 to 3 (docs/spec/text-size.md).
const UP = [1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DOWN = [2.5, 2, 1.75, 1.5, 1.25, 1.1, 1];

/** Sets the frame scale to factor and waits until that screen is displayed. */
async function setFrame(s, factor) {
  await s.run("core.settings.set", { patch: { textSize: factor }, scope: "common" });
  await s.until("core.text", (value) => value.frame === factor, `the frame factor did not become ${factor}`);
  await s.presented();
}

/** The button rectangle of the window to record and the refresh rate of the display. An occluded window is not measured because WebKit draws it less. */
async function recordable(s) {
  const window = await s.get("host.window");
  if (window.occluded) {
    throw new Error(`${s.app.name}'s window is completely covered by ${coveredBy(s, window)}, so WebKit renders it less often. ` +
      "Nothing was measured: uncover the window, without activating the application, and run the check again.");
  }
  assert.equal(window.controls.length, 3, `the window reports ${window.controls.length} buttons`);
  assert.ok(window.controls.every((button) => !button.hidden), "a window button is hidden");
  return { buttons: window.controls, refreshRate: window.refreshRate };
}

/**
 * Runs action(displayed) while the window is recorded. action returns, in order, the states { displayed, at } displayed during the recording (display time,
 * first-row height). It measures the buttons and the first row in each frame and deletes the recording folder.
 */
async function record(s, buttons, action) {
  const { displayed } = await s.presented();
  const recording = await s.record();
  try {
    const poses = await action(displayed);
    const stop = await recording.stop({ after: poses.at(-1).displayed + 100 });
    assert.equal(stop.limited, false, "the recording reached its frame cap");
    // Reads and measures one frame at a time. The whole recording is not held in memory.
    const measured = frames(recording.frames).map((path, index) => ({ index, ...measureTitlebar(readFrame(path), buttons) }));
    return { poses, stop, measured };
  } finally {
    // A failure to stop the recording is stopped by the session cleanup (Session.record).
    rmSync(recording.frames, { recursive: true, force: true });
  }
}

/**
 * Judges that in every frame the button center and the first-row center are within TOLERANCE, and that every displayed state was recorded within two screen frames
 * after its display.
 */
function judge(t, label, { poses, stop, measured }, refreshRate) {
  assert.ok(measured.length > 1, `${label}: the recording has ${measured.length} frames`);
  const off = misaligned(measured);
  const recorded = measured.filter((frame) => frame.row !== undefined).map((frame) => ({ time: frame.time, edges: [frame.row] }));
  const missing = recorded.length ? missingPoses(recorded, poses, refreshRate) : poses;
  const largest = Math.max(...measured.filter((frame) => frame.difference !== undefined).map((frame) => Math.abs(frame.difference)));
  t.diagnostic(`${label}: ${measured.length} frames, rows ${[...new Set(recorded.map((frame) => frame.edges[0]))].join(",")}, ` +
    `largest difference ${largest.toFixed(2)}px, longest gap ${stop.longestGap}ms, ${stop.layouts.length} layout transactions`);
  assert.equal(off.length, 0, `${label}: ${off.length} of ${measured.length} frames have the window button centre more than ` +
    `${TOLERANCE}px from the first-row centre or cannot be measured: ${JSON.stringify(off.slice(0, 12))}`);
  assert.deepEqual(missing, [], `${label}: displayed first rows missing from the recording at ${refreshRate}Hz`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: every recorded frame keeps the window buttons centred in the first row while the frame factor steps from 1 to 3 and back`,
    { timeout: 120000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s);
      s.cleanup(() => setFrame(s, 1));
      await setFrame(s, 1);
      // Pressing the frame makes the frame the scope of the text size command.
      const spaceTab = await s.rect("core.space-tab", 0);
      await s.click((spaceTab.document?.x ?? 0) + spaceTab.x + spaceTab.width / 2,
        (spaceTab.document?.y ?? 0) + spaceTab.y + spaceTab.height / 2);
      await s.until("core.text", (value) => value.scope.kind === "frame", "pressing the frame did not make it the text size scope");
      const { buttons, refreshRate } = await recordable(s);
      for (const [label, from, steps, command] of [["up", 1, UP, "core.text.larger"], ["down", 3, DOWN, "core.text.smaller"]]) {
        judge(t, label, await record(s, buttons, async (displayed) => {
          const poses = [{ displayed, at: rowHeight(from) }];
          for (const factor of steps) {
            await s.run(command);
            await s.until("core.text", (value) => value.frame === factor, `the frame factor did not reach ${factor}`);
            poses.push({ displayed: (await s.presented()).displayed, at: rowHeight(factor) });
          }
          return poses;
        }), refreshRate);
      }
    });

  test(`${app.name}: every recorded frame of a reload after another window changed the frame factor keeps the window buttons centred`,
    { timeout: 120000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s);
      s.cleanup(() => setFrame(s, 1));
      await setFrame(s, 1);
      await s.run("core.window.new");
      const list = await s.windows(2, "the new window did not open");
      const other = s.on(list.find((w) => w.window !== s.window).window);
      s.cleanup(() => other.close());
      await other.until("core.screen", (value) => value.screen === "library", "the new window did not show the library");
      const { buttons, refreshRate } = await recordable(s);
      const before = (await s.get("core.window.document")).timeOrigin;
      // The setting of another window changes the common scale, and this window reads again before or after it draws that notification. Either way every frame must keep the
      // criterion.
      judge(t, "reload", await record(s, buttons, async (displayed) => {
        await other.run("core.settings.change", { key: "textSize", value: 2, scope: "common" });
        await other.until("core.text", (value) => value.frame === 2, "the other window did not take frame factor 2");
        await s.run("host.window.reload");
        await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
          "the main document did not reload");
        await s.until("core.text", (value) => value.frame === 2, "the reloaded page did not take frame factor 2");
        return [{ displayed, at: rowHeight(1) }, { displayed: (await s.presented()).displayed, at: rowHeight(2) }];
      }), refreshRate);
    });
}
