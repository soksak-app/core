// Measures by recording whether a new window goes on the screen with its complete first screen (docs/spec/native-host.md). The recording of the new window
// starts as soon as the window is listed, so it holds callbacks from before the window shows: idle or blank callbacks of a window that is not on the screen
// yet, or frames in which a window that the host keeps transparent is not visible. A recording without them started after the window went on the screen and
// proves nothing, so the check fails. Every frame in which the window is visible must show the logo at its place and, in a project window, the card color
// (screen-drawn.mjs). The reference of a recording is its last visible frame, the settled first screen.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { readFrame } from "@soksak/window-check/frame.mjs";
import { beforeReveal, cardPoint, LOGO, undrawn, visible } from "./screen-drawn.mjs";

/** The window of the window list that is not the window of s. */
const added = (s, list) => list.find((w) => w.window !== s.window).window;

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
 * Runs opening, records the window it adds from the moment that window is listed until it shows its first screen, and checks the recording. ready waits
 * for the first screen of the window and returns the card point to check, or null for a screen without cards.
 */
async function firstScreen(t, s, label, opening, ready) {
  await opening();
  const child = s.on(added(s, await s.windows(2, `${label}: the window did not open`)));
  const recording = await child.record();
  const card = await ready(child);
  const shown = await child.presented();
  const stop = await recording.stop({ after: shown.displayed + 100 });
  assert.equal(stop.limited, false, `${label}: the recording reached its frame cap`);
  const records = readFileSync(stop.callbackStatus, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const read = new Map();
  const frame = (name) => {
    if (!read.has(name)) read.set(name, readFrame(join(recording.frames, name)));
    return read.get(name);
  };
  const hidden = beforeReveal(records, (name) => visible(frame(name), LOGO));
  const shownFrames = records.filter((record) => record.status === 0 && record.frame !== null)
    .sort((a, b) => a.sequence - b.sequence).map((record) => frame(record.frame)).filter((item) => visible(item, LOGO));
  const missing = undrawn(shownFrames, { logo: LOGO, card, reference: shownFrames.at(-1) });
  t.diagnostic(`${label}: ${hidden.length} callbacks before the window showed ` +
    `${JSON.stringify(hidden.slice(0, 6).map((record) => record.status))}; ${shownFrames.length} visible frames; ` +
    `undrawn ${JSON.stringify(missing.slice(0, 6))}`);
  assert.ok(hidden.length > 0, `${label}: the recording started after the window went on the screen, so it cannot show the first frame of the window: ` +
    `${JSON.stringify(records.slice(0, 6).map((record) => record.status))}`);
  assert.deepEqual(missing, [], `${label}: the window showed frames without the logo at its place or without the card`);
  rmSync(recording.frames, { recursive: true, force: true });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a new window goes on the screen with its complete first screen`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    closeOthers(s, "new window");
    await firstScreen(t, s, "new window", () => s.run("core.window.new"), async (child) => {
      await child.until("core.screen", (value) => value.screen === "library", "the new window did not show the library");
      return null;
    });
  });

  test(`${app.name}: a project window goes on the screen with its complete first screen`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-first-screen-")));
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
    await firstScreen(t, s, "project window", () => s.run("core.project.open", { root, color: "#7fe3b0" }), async (child) => {
      const grid = await child.until("core.grid", (value) => value?.cards?.length > 0, "the project window did not show its cards");
      return cardPoint(grid);
    });
  });
}
