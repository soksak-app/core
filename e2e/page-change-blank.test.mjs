// Measures by recording whether the window shows an incompletely drawn screen while the page changes (docs/spec/surface-composition.md). It looks at two places in each frame.
// The logo text of the head row must be in its place to the right of the traffic light buttons (before the application style applies, the logo is pushed toward
// the buttons), and the card head must have the card color (if the workspace is empty, only the window background shows).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";

const near = (a, b, tolerance) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

/** The frame pixel at the window coordinate (points) point. */
function sample(frame, point) {
  const scale = frame.scale * frame.contentScale;
  return pixel(frame, Math.floor(frame.content.x * frame.scale + point.x * scale),
    Math.floor(frame.content.y * frame.scale + point.y * scale));
}

/** The number of pixels inside rect (window coordinates) that differ from background by more than 40. */
function ink(frame, rect, background) {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (sample(frame, { x, y }).some((value, index) => Math.abs(value - background[index]) > 40)) count++;
    }
  }
  return count;
}

/**
 * An incompletely drawn frame. logo is the area of the logo text in its place, and card is one point that must have the card color (it is not examined when absent). The reference is
 * the first frame of the recording.
 */
function undrawn(captured, logo, card) {
  const first = captured[0];
  const background = sample(first, { x: logo.x - 4, y: logo.y + logo.height / 2 });
  const cardColour = card ? sample(first, card) : null;
  assert.ok(ink(first, logo, background) > 0, "the first frame has no logo text at its place");
  return captured.map((frame, index) => ({ index, logo: ink(frame, logo, background), card: card ? sample(frame, card) : null }))
    .filter((item) => item.logo === 0 || (card && !near(item.card, cardColour, 12)))
    .map((item) => ({ ...item, expected: cardColour }));
}

async function record(s, action) {
  const { displayed } = await s.presented();
  const recording = await s.record();
  try {
    await action();
    const shown = await s.presented();
    const stop = await recording.stop({ after: Math.max(displayed, shown.displayed) + 100 });
    assert.equal(stop.limited, false, "the recording reached its frame cap");
    return frames(recording.frames).map(readFrame);
  } finally {
    // If the recording cannot be stopped, the session cleanup stops it (Session.record).
    rmSync(recording.frames, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: page changes keep the window drawn`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // The logo text is to the right of the logo icon in the window head row. If the logo is pushed toward the traffic light buttons, this area is empty.
    const logo = { x: 112, y: 13, width: 48, height: 12 };
    const grid = await s.get("core.grid");
    const content = grid.cards.find((item) => item.tabs?.length);
    assert.ok(content, "no content card");
    const card = { x: grid.plane.x + content.x + content.w / 2, y: grid.plane.y + content.y + 3 };
    const reload = undrawn(await record(s, async () => {
      const before = (await s.get("core.window.document")).timeOrigin;
      await s.run("host.window.reload");
      await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
        "the main document did not reload");
    }), logo, card);
    const library = undrawn(await record(s, async () => {
      await s.run("core.projects.browse");
      await s.until("core.screen", (value) => value.screen === "library", "the library did not open");
      await s.run("core.library.return");
      await s.until("core.screen", (value) => value.screen === "workspace", "the library did not return to the workspace");
    }), logo, null);
    t.diagnostic(`reload: ${reload.length} undrawn frames ${JSON.stringify(reload.slice(0, 6))}; library: ${library.length}`);
    assert.deepEqual(reload, [], "a reload showed frames without the logo at its place or without the card");
    assert.deepEqual(library, [], "opening and leaving the library showed frames without the logo at its place");
  });
}
