// Measures by recording whether a new window draws a complete first screen from the first frame in which it is visible (docs/spec/surface-composition.md,
// docs/spec/native-host.md). The recording of a new window (diagnostics.capture.start newWindow, docs/spec/endpoint.md) holds the show of the next window of
// the application and puts it on screen at the start of its stream, so the recording has the first frame in which the window is on screen. A new window is
// transparent until its reveal, so its first frames are transparent, and a recording that does not show the window appear fails. Two windows are measured:
// a new window, which shows the library, and the window of a project that opens in its own window.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { alpha, cardPoint, fullSize, LOGO, sample, undrawn } from "./screen-drawn.mjs";

/** The pixels seen at every grid step inside rect (window coordinates) of view. */
function grid(view, rect, step) {
  const values = [];
  for (let y = rect.y + step / 2; y < rect.y + rect.height; y += step) {
    for (let x = rect.x + step / 2; x < rect.x + rect.width; x += step) values.push(sample(view, { x, y }));
  }
  return values;
}

/** The number of points at every grid step inside rect (window coordinates) of view where the window is not transparent (alpha above 0). */
function opaque(view, rect, step) {
  let count = 0;
  for (let y = rect.y + step / 2; y < rect.y + rect.height; y += step) {
    for (let x = rect.x + step / 2; x < rect.x + rect.width; x += step) if (alpha(view, { x, y }) > 0) count++;
  }
  return count;
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
 * Records the new window that opening adds from its first frame, and checks the frames of that window. ready waits for the first screen of the window and
 * returns the card point (window points) that must have the card color, or null for a screen without cards.
 */
async function firstFrames(t, s, label, opening, ready) {
  const recording = await s.record({ newWindow: true });
  await opening();
  const list = await s.windows(2, `${label}: the window did not open`);
  const child = s.on(list.find((w) => w.window !== s.window).window);
  const card = await ready(child);
  // A host shows a new window only after its first screen (docs/spec/native-host.md#page-start), so the workbench can be ready while the window is still
  // transparent; the presented time of a window that waits for its reveal is the frame after the reveal, so the recording ends after the window shows.
  const shown = await child.presented();
  const stop = await recording.stop({ after: shown.displayed + 100 });
  assert.equal(stop.limited, false, `${label}: the recording reached its frame cap`);
  const window = (await child.get("host.window")).frame;
  // A window recording reads the window itself, so the window points of LOGO and cardPoint sample its frames.
  // A new window opens on the display of the frontmost window of the application (native/darwin/src/window_reveal.h), so the recording holds it.
  assert.ok(window.x >= display.x && window.y >= display.y && window.x + window.width <= display.x + display.width &&
    window.y + window.height <= display.y + display.height,
    `${label}: the new window ${JSON.stringify(window)} is not inside the recorded display ${JSON.stringify(display)}`);
  const captured = frames(recording.frames).map(readFrame);
  assert.ok(captured.length > 1, `${label}: the recording has ${captured.length} frames`);
  const region = { x: 0, y: 0, width: window.width, height: window.height };
  // The window opening animation starts the window slightly smaller, so the content is counted in the inner region that the window covers from the start.
  const inner = { x: region.width * 0.06, y: region.height * 0.06, width: region.width * 0.88, height: region.height * 0.88 };
  const last = captured.at(-1);
  // The background of the first screen is the color of the empty area below the library or the cards.
  const background = sample(last, { x: region.width / 2, y: region.height * 0.85 });
  const ink = (view) => grid(view, inner, 8)
    .filter((value) => value.some((channel, index) => Math.abs(channel - background[index]) > 40)).length;
  const complete = ink(last);
  assert.ok(complete > 0, `${label}: the last frame shows no content in the new window`);
  // A new window is transparent until its reveal, and a window recording reads it so: every pixel of such a frame has alpha 0. The window appears at the
  // first frame with a pixel that is not transparent, and a recording whose first frame already shows the window does not show it appear.
  const rows = captured.map((view, index) => ({ index, time: Math.round(view.time - captured[0].time),
    opaque: opaque(view, region, 16), ink: ink(view) }));
  const first = rows.findIndex((row) => row.opaque > 0);
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
