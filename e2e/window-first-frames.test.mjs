// Measures by recording whether a new window draws a complete first screen from the first frame in which it is visible (docs/spec/surface-composition.md,
// docs/spec/native-host.md). A recording can start only after the window exists, so on a display that has existing windows, a display recording that covers
// all windows of this application captures the moment the new window appears, and a recording that does not show the window appear fails. The region of the
// new window is set with the screen coordinates of that window after the recording ends. Two windows are measured: a new window, which shows the library, and
// the window of a project that opens in its own window.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { cardPoint, fullSize, inWindow, LOGO, sample, undrawn } from "./screen-drawn.mjs";

/** The pixels seen at every grid step inside rect (window coordinates) of view. */
function grid(view, rect, step) {
  const values = [];
  for (let y = rect.y + step / 2; y < rect.y + rect.height; y += step) {
    for (let x = rect.x + step / 2; x < rect.x + rect.width; x += step) values.push(sample(view, { x, y }));
  }
  return values;
}

/** The ratio of points where the channel difference between the two grids exceeds tolerance. */
function differing(a, b, tolerance) {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i].some((value, channel) => Math.abs(value - b[i][channel]) > tolerance)) count++;
  return count / a.length;
}

/** Closes every window but the window of s when the check ends. */
function closeOthers(s, label) {
  s.cleanup(async () => {
    for (const window of await s.get("host.windows")) {
      if (window.window !== s.window) await s.on(window.window).close();
    }
    await s.windows(1, `${label}: the cleanup left an extra window`);
  });
}

/**
 * Records the display while opening adds a window, and checks the frames of that window. ready waits for the first screen of the window and returns the
 * card point (window points) that must have the card color, or null for a screen without cards.
 */
async function firstFrames(t, s, label, opening, ready) {
  const { displayed } = await s.presented();
  const recording = await s.record({ display: true });
  await opening();
  const list = await s.windows(2, `${label}: the window did not open`);
  const child = s.on(list.find((w) => w.window !== s.window).window);
  const card = await ready(child);
  // A host shows a new window only after its first screen (docs/spec/native-host.md#page-start), so the workbench can be ready while
  // the window is still off the screen, and the presented time of a window on no screen is the time of the call. The recording ends
  // after the window is on the screen; the presented time of a window that waits for its reveal is the frame after the reveal.
  await child.until("host.window", (value) => value.occluded === false, `${label}: the new window did not show on the screen`);
  const shown = await child.presented();
  const stop = await recording.stop({ after: Math.max(displayed, shown.displayed) + 100 });
  assert.equal(stop.limited, false, `${label}: the recording reached its frame cap`);
  const window = (await child.get("host.window")).frame;
  // A display recording covers the display that holds the center of the recorded window (native/darwin/src/capture.m).
  const own = (await s.get("host.window")).frame;
  const centre = { x: own.x + own.width / 2, y: own.y + own.height / 2 };
  const display = (await s.get("host.screens")).find((screen) => centre.x >= screen.x && centre.x < screen.x + screen.width &&
    centre.y >= screen.y && centre.y < screen.y + screen.height);
  assert.ok(display, `${label}: no screen holds the recorded window ${JSON.stringify(own)}`);
  // A new window opens on the display of the frontmost window of the application (native/darwin/src/window_reveal.h), so the recording holds it.
  assert.ok(window.x >= display.x && window.y >= display.y && window.x + window.width <= display.x + display.width &&
    window.y + window.height <= display.y + display.height,
    `${label}: the new window ${JSON.stringify(window)} is not inside the recorded display ${JSON.stringify(display)}`);
  const captured = frames(recording.frames).map(readFrame).map((frame) => inWindow(frame, display, window));
  assert.ok(captured.length > 1, `${label}: the recording has ${captured.length} frames`);
  const region = { x: 0, y: 0, width: window.width, height: window.height };
  // The window opening animation starts the window slightly smaller, so the content is counted in the inner region that the window covers from the start.
  const inner = { x: region.width * 0.06, y: region.height * 0.06, width: region.width * 0.88, height: region.height * 0.88 };
  const before = grid(captured[0], region, 16);
  const last = captured.at(-1);
  // The background of the first screen is the color of the empty area below the library or the cards.
  const background = sample(last, { x: region.width / 2, y: region.height * 0.85 });
  const ink = (view) => grid(view, inner, 8)
    .filter((value) => value.some((channel, index) => Math.abs(channel - background[index]) > 40)).length;
  const complete = ink(last);
  assert.ok(complete > 0, `${label}: the last frame shows no content in the new window`);
  const rows = captured.map((view, index) => ({ index, time: Math.round(view.time - captured[0].time),
    shown: differing(grid(view, region, 16), before, 12), ink: ink(view) }));
  const first = rows.findIndex((row) => row.shown > 0.05);
  assert.ok(first > 0, `${label}: the recording does not show the new window appear: ${JSON.stringify(rows.slice(0, 3))}`);
  const empty = rows.slice(first).filter((row) => row.ink < complete / 2);
  // Once the window shows at its full size, each frame has the logo at its place and the card color of the last frame.
  const whole = captured.slice(first).filter((view) => fullSize(view, last, region));
  const missing = undrawn(whole, { logo: LOGO, card, reference: last });
  t.diagnostic(`${label}: window ${JSON.stringify(window)}; appears at frame ${first} of ${rows.length}; complete ink ${complete}; ` +
    `empty ${JSON.stringify(empty)}; ${whole.length} frames at full size, undrawn ${JSON.stringify(missing.slice(0, 6))}`);
  assert.deepEqual(empty, [], `${label}: the new window showed frames without its first screen`);
  assert.deepEqual(missing, [], `${label}: the new window showed frames without the logo at its place or without the card`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a new window shows its complete first screen from its first frame`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    closeOthers(s, "new window");
    await firstFrames(t, s, "new window", () => s.run("core.window.new"), async (child) => {
      await child.until("core.screen", (value) => value.screen === "library", "the new window did not show the library");
      return null;
    });
  });

  test(`${app.name}: a project window shows its complete first screen from its first frame`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-first-frames-")));
    const root = join(temporary, "project");
    mkdirSync(root);
    s.cleanup(() => rmSync(temporary, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    closeOthers(s, "project window");
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await firstFrames(t, s, "project window", () => s.run("core.project.open", { root, color: "#7fe3b0" }), async (child) => {
      const value = await child.until("core.grid", (item) => item?.cards?.length > 0, "the project window did not show its cards");
      return cardPoint(value);
    });
  });
}
