// Checks that the window buttons are at the center of the first row, and still there after maximize, record, move, resize, and title change.
import assert from "node:assert/strict";
import test from "node:test";

import { rmSync } from "node:fs";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";

const PLAN = { axis: "x", line: 2, dx: -250, dy: 0, ms: 48, times: 3 };

/** The number of times the window change is repeated. */
const ROUNDS = 6;

/** Confirms that the three window buttons are visible and at the center of the window head row. */
async function centred(s, when) {
  const state = await s.get("host.window");
  const bar = await s.rect("core.chrome.bar");
  assert.equal(state.controls.length, 3);
  for (const button of state.controls) {
    assert.equal(button.hidden, false, `a native button is hidden ${when}`);
    const offset = button.y + button.height / 2 - (bar.y + bar.height / 2);
    assert.ok(Math.abs(offset) <= 0.25,
      `native button is ${offset}pt from the row centre ${when}: ${JSON.stringify(button)}, row ${JSON.stringify(bar)}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising the window leaves its own buttons in place`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const before = (await s.get("host.window")).frame;
    await s.run("host.window.maximize", { on: true });
    try {
      await s.until("host.window", (w) => w.frame.width !== before.width || w.frame.height !== before.height,
        "the window did not maximise");
      await s.presented();
      await centred(s, "after maximising");
    } finally {
      await s.run("host.window.maximize", { on: false });
      await s.until("host.window", (w) => w.frame.width === before.width && w.frame.height === before.height,
        "the window did not return to its size");
      await s.presented();
    }
  });

  test(`${app.name}: the soksak logo letters are light in dark mode and dark in light mode`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "mode" }));
    // Logo text color. The icon tile is the same in both modes.
    for (const [mode, letters] of [["dark", [237, 230, 216]], ["light", [22, 24, 29]]]) {
      await s.run("core.settings.change", { key: "mode", value: mode, scope: "common" });
      await s.until("core.window.document", (document) => document?.scheme === mode, `the document did not take the ${mode} mode`);
      const logo = await s.rect("core.brand");
      await s.request("diagnostics.capture.start", {});
      const displayed = await s.presented();
      const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
      try {
        const frame = readFrame(frames(directory).at(-1));
        // The text is to the right, starting at 102 of the logo width 323.
        const left = Math.round((logo.x + logo.width * 102 / 323) * frame.scale);
        const right = Math.round((logo.x + logo.width) * frame.scale);
        let matched = 0;
        for (let y = Math.round(logo.y * frame.scale); y < Math.round((logo.y + logo.height) * frame.scale); y++) {
          for (let x = left; x < right; x++) {
            const value = pixel(frame, x, y);
            if (value.every((channel, index) => Math.abs(channel - letters[index]) <= 12)) matched++;
          }
        }
        assert.ok(matched >= 20, `${mode}: only ${matched} pixels of the logo letters are ${JSON.stringify(letters)}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test(`${app.name}: stopping a window recording leaves the native buttons centred`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await drag(t, s, PLAN, { capture: true });
    // When the window title or the recording indicator changes, AppKit takes the buttons back, and the library puts them again before the next run loop
    // turn. A request that is processed in the same turn can read the position in between, so the next
    // position after the display is measured.
    await s.presented();
    await centred(s, "after recording");
  });

  test(`${app.name}: full screen keeps the first row height`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const row = (await s.rect("core.chrome.bar")).height;
    assert.ok(row > 0, "the first row has no height");
    await s.run("host.window.fullscreen", { on: true });
    try {
      await s.until("host.window", (w) => w.content.height > 760, "the window did not enter full screen");
      await s.presented();
      // In full screen the window moves the buttons out of the first row. The height of the row follows the title bar, so it stays the same.
      assert.equal((await s.rect("core.chrome.bar")).height, row, "full screen changed the first row height");
      assert.equal((await s.get("core.verify")).failed, 0, "the page reported a failed check in full screen");
    } finally {
      await s.run("host.window.fullscreen", { on: false });
      await s.until("host.window", (w) => w.content.height === 760, "the window did not leave full screen");
      await s.presented();
    }
    assert.equal((await s.rect("core.chrome.bar")).height, row, "leaving full screen changed the first row height");
  });

  test(`${app.name}: moving, resizing, and renaming keep the buttons centred in the first row`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const start = (await s.get("host.window")).frame;
    const project = await s.get("core.project");
    // The usable area of the screen that has the window is the size of the maximized window. The next operation is done after the window reaches that size.
    // If restore is requested while the zoom is in progress, the window stays maximized.
    const screen = (await s.get("host.screens")).find((x) => start.x >= x.x && start.x < x.x + x.width
      && start.y >= x.y && start.y < x.y + x.height);
    try {
      for (let round = 0; round < ROUNDS; round++) {
        await s.run("host.window.move", { x: start.x + 40, y: start.y + 30 });
        await centred(s, "after moving the window");
        await s.run("host.window.move", { x: start.x, y: start.y });
        await s.run("host.window.resize", { width: start.width - 100, height: start.height - 60 });
        await centred(s, "after resizing the window");
        await s.run("host.window.resize", { width: start.width, height: start.height });
        await s.run("host.window.maximize", { on: true });
        await s.until("host.window", (w) => w.maximized && w.frame.width === screen.visible.width
          && w.frame.height === screen.visible.height, "the window did not maximise");
        await centred(s, "while the window is maximised");
        await s.run("host.window.maximize", { on: false });
        await s.until("host.window", (w) => !w.maximized && w.frame.width === start.width,
          "the window did not return to its size");
        // When the title changes, AppKit lays out the title bar again.
        await s.run("core.project.rename", { id: project.id, title: `${project.title}` });
        await centred(s, "after a title change");
      }
    } finally {
      await s.run("host.window.maximize", { on: false });
      await s.run("host.window.resize", { width: start.width, height: start.height });
      await s.run("host.window.move", { x: start.x, y: start.y });
    }
    t.diagnostic(`the buttons stayed centred through ${ROUNDS} rounds of window changes`);
  });
}
