// Records the maximize and restore of the window, checks that the app layout matches the window size after the change ends, and reports
// the number of frames in which the layout was later than the window during the change.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";

/**
 * A frame in which the margin between the right and bottom edges of the layout and the window edges differs from the reference by more than this amount (pt) is a frame in which the layout is later than the window.
 * When the window grows, the margin widens; when it shrinks, the previous layout is clipped outside the window and the margin disappears.
 */
const LAG = 12;

/** Time (ms) allowed for the layout to follow after the window reaches the new size. */
const CATCH_UP = 150;

/** Time (ms) added after the display time so that the recording also covers the interval in which the layout follows. */
const SETTLE = 100;

/** Brightness darker than the card border and the glyphs. The window background and the empty area are darker than this. */
const BRIGHT = 70;

/**
 * Measures in window points the window size and the rightmost column and the lowest row that hold a bright pixel in the frame.
 * The buffer is fixed at the recording start size, and a grown window is stored reduced by contentScale.
 */
function measure(frame) {
  const ratio = frame.contentScale * frame.scale;
  const width = Math.floor(frame.content.width * frame.scale);
  const height = Math.floor(frame.content.height * frame.scale);
  const bright = (x, y) => {
    const i = y * frame.stride + x * 4;
    return Math.max(frame.data[i], frame.data[i + 1], frame.data[i + 2]) > BRIGHT;
  };
  let right = -1;
  for (let x = width - 1; x >= 0 && right < 0; x--) {
    for (let y = 0; y < height; y++) if (bright(x, y)) { right = x; break; }
  }
  let bottom = -1;
  for (let y = height - 1; y >= 0 && bottom < 0; y--) {
    for (let x = 0; x < width; x++) if (bright(x, y)) { bottom = y; break; }
  }
  return {
    time: frame.time,
    window: { width: frame.content.width / frame.contentScale, height: frame.content.height / frame.contentScale },
    gap: { x: frame.content.width / frame.contentScale - (right + 1) / ratio,
      y: frame.content.height / frame.contentScale - (bottom + 1) / ratio },
  };
}

/** Records the change that resizes the window and measures the frames until the layout is displayed at the new size. */
const right = (w) => Math.max(...w.surfaces.filter((x) => x.visible).map((x) => x.frame.x + x.frame.width));

/** Distance between the right edge of the window and the rightmost surface. The layout keeps this distance regardless of the window size. */
const margin = (w) => w.content.width - right(w);

async function record(s, change, sized) {
  const kept = margin(await s.get("host.window"));
  const { frames: directory } = await s.request("diagnostics.capture.start");
  // The recording stores frames of the window size at up to 60 per second, so it is deleted right after the measurement.
  try {
    // The recording covers the screen up to this display time. A screen that the app committed is displayed after the display wait ends.
    let displayed = 0;
    try {
      await change();
      // Waits until the window reaches the new size, the surface moves to the layout of that size and that layout is displayed.
      await s.until("host.window", (w) => sized(w) && Math.abs(margin(w) - kept) < 1,
        "the surfaces did not follow the window");
      ({ displayed } = await s.presented());
    } finally {
      // Covers the interval in which the layout follows after the window reaches the new size.
      await s.request("diagnostics.capture.stop", { after: displayed ? displayed + SETTLE : 0 });
    }
    return { displayed, measured: frames(directory).map((path) => measure(readFrame(path))) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Checks that the layout of the last displayed frame after the change ends matches the window size, and reports the number of frames in which the layout
 * was later than the window during the change. The window frame and the WebKit content are displayed separately (WebKit/WebKit#72971,
 * tauri-apps/tao#1207), so late frames during the change remain only as a measured value.
 */
function assertSettled(t, { displayed, measured }, label) {
  assert.ok(measured.length > 1, `${label}: only ${measured.length} frames were recorded`);
  const [first] = measured;
  const last = measured.at(-1);
  const tail = measured.slice(-5).map((m) =>
    `${(m.time - first.time).toFixed(0)}ms ${m.window.width.toFixed(0)}×${m.window.height.toFixed(0)} gap ${m.gap.x.toFixed(0)},${m.gap.y.toFixed(0)}`);
  const shown = `presented for display at ${(displayed - first.time).toFixed(0)}ms`;
  assert.ok(Math.abs(last.window.width - first.window.width) > 100,
    `${label}: the recording did not include the resized window (${first.window.width} → ${last.window.width}; ` +
    `${shown}; last frames ${tail.join(", ")})`);
  const off = (m) => Math.abs(m.gap.x - first.gap.x) > LAG || Math.abs(m.gap.y - first.gap.y) > LAG;
  const late = measured.filter(off);
  const took = late.length ? late.at(-1).time - first.time : 0;
  t.diagnostic(`${label}: ${late.length} of ${measured.length} frames show the layout behind the window, the last at ${took.toFixed(0)}ms`);
  assert.ok(took <= CATCH_UP, `${label}: the layout stayed behind the window for ${took.toFixed(0)}ms, more than ${CATCH_UP}ms ` +
    `(${shown}; last frames ${tail.join(", ")})`);
  assert.ok(!off(last), `${label}: the settled frame shows the layout behind the window ` +
    `(window ${last.window.width.toFixed(0)}×${last.window.height.toFixed(0)}, gap ${last.gap.x.toFixed(0)},${last.gap.y.toFixed(0)}, ` +
    `base gap ${first.gap.x.toFixed(0)},${first.gap.y.toFixed(0)}; ${shown}; last frames ${tail.join(", ")})`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising and restoring settle with the layout at the window size`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
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

    const grown = await record(s, async () => {
      maximised = true;
      await s.run("host.window.maximize", { on: true });
    }, (w) => same(w.frame, screen.visible));
    assertSettled(t, grown, "maximising");

    const shrunk = await record(s, () => s.run("host.window.maximize", { on: false }),
      (w) => same(w.frame, before));
    maximised = false;
    assertSettled(t, shrunk, "restoring");
  });
}
