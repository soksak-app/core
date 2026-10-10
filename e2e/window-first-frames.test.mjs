// Measures by recording whether a new window draws a complete first screen from the first frame in which it is visible (docs/spec/surface-composition.md). A recording can start only after
// the window exists, so on a display that has existing windows, a display recording that covers all windows of this application captures the moment the new window
// appears. The region of the new window is set with the screen coordinates of that window after the recording ends.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";

/** The pixel at screen coordinate (points) point in a display recording frame. The origin of the display is display. */
function sample(frame, display, point) {
  const scale = frame.scale * frame.contentScale;
  return pixel(frame, Math.floor((frame.content.x + point.x - display.x) * scale),
    Math.floor((frame.content.y + point.y - display.y) * scale));
}

/** The pixels seen at every grid step inside rect (screen coordinates). */
function grid(frame, display, rect, step) {
  const values = [];
  for (let y = rect.y + step / 2; y < rect.y + rect.height; y += step) {
    for (let x = rect.x + step / 2; x < rect.x + rect.width; x += step) values.push(sample(frame, display, { x, y }));
  }
  return values;
}

/** The ratio of points where the channel difference between the two grids exceeds tolerance. */
function differing(a, b, tolerance) {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i].some((value, channel) => Math.abs(value - b[i][channel]) > tolerance)) count++;
  return count / a.length;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a new window shows its complete first screen from its first frame`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const { displayed } = await s.presented();
    const recording = await s.record({ display: true });
    let child;
    try {
      await s.run("core.window.new");
      const list = await s.windows(2, "the new window did not open");
      child = s.on(list.find((w) => w.window !== s.window).window);
      await child.until("core.screen", (value) => value.screen === "library", "the new window did not show the library");
      const shown = await child.presented();
      const stop = await recording.stop({ after: Math.max(displayed, shown.displayed) + 100 });
      assert.equal(stop.limited, false, "the recording reached its frame cap");
      const window = (await child.get("host.window")).frame;
      // A display recording covers the display that holds the center of the recorded window (native/darwin/src/capture.m).
      const own = (await s.get("host.window")).frame;
      const centre = { x: own.x + own.width / 2, y: own.y + own.height / 2 };
      const display = (await s.get("host.screens")).find((screen) => centre.x >= screen.x && centre.x < screen.x + screen.width &&
        centre.y >= screen.y && centre.y < screen.y + screen.height);
      assert.ok(display, `no screen holds the recorded window ${JSON.stringify(own)}`);
      const captured = frames(recording.frames).map(readFrame);
      assert.ok(captured.length > 1, `the recording has ${captured.length} frames`);
      const region = { x: window.x, y: window.y, width: window.width, height: window.height };
      // The window opening animation starts the window slightly smaller, so the content is counted in the inner region that the window covers from the start.
      const inner = { x: region.x + region.width * 0.06, y: region.y + region.height * 0.06,
        width: region.width * 0.88, height: region.height * 0.88 };
      const before = grid(captured[0], display, region, 16);
      const last = captured.at(-1);
      // The background of the first screen is the color of the empty area below the library.
      const background = sample(last, display, { x: region.x + region.width / 2, y: region.y + region.height * 0.85 });
      const ink = (frame) => grid(frame, display, inner, 8)
        .filter((value) => value.some((channel, index) => Math.abs(channel - background[index]) > 40)).length;
      const complete = ink(last);
      assert.ok(complete > 0, "the last frame shows no content in the new window");
      const rows = captured.map((frame, index) => ({ index, time: Math.round(frame.time - captured[0].time),
        shown: differing(grid(frame, display, region, 16), before, 12), ink: ink(frame) }));
      const first = rows.findIndex((row) => row.shown > 0.05);
      assert.ok(first > 0, `the recording does not show the new window appear: ${JSON.stringify(rows.slice(0, 3))}`);
      const undrawn = rows.slice(first).filter((row) => row.ink < complete / 2);
      t.diagnostic(`window ${JSON.stringify(region)}; appears at frame ${first} of ${rows.length}; complete ink ${complete}; ` +
        `undrawn ${JSON.stringify(undrawn)}`);
      assert.deepEqual(undrawn, [], "the new window showed frames without its first screen");
    } finally {
      if (child) await child.close();
    }
  });
}
