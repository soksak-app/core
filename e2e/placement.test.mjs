// Position of the check windows and the report of covering: fresh puts each check application at its windowPosition of
// @soksak/window-check, and a covered window tells the observer its covered state.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open, requiresAll, windowPosition } from "@soksak/window-check/app.mjs";
import { fresh, uncoverFromCheckWindows } from "./fixture.mjs";

// The check places the window of every application, so it is registered only when the required set holds all of them.
if (requiresAll(process.env)) test("fresh places every check window at its own frame", async (t) => {
  const sessions = [];
  for (const app of Object.values(APPS)) {
    const s = await open(t, app);
    sessions.push(s);
  }
  // Moves every window onto the position of the first one and then checks that fresh returns each to its own position.
  // Positioning sets only the position of the window. Whether a window of another application covers a check window does
  // not depend on the position, so this check does not measure it.
  const [first, ...others] = sessions;
  const { frame } = await first.get("host.window");
  for (const s of others) {
    await s.run("host.window.move", { x: frame.x, y: frame.y });
    await s.until("host.window", (w) => w.frame.x === frame.x && w.frame.y === frame.y, `the ${s.app.name} window did not move onto the first`);
  }
  for (const s of sessions) await fresh(s);
  const [screen] = await first.get("host.screens");
  const area = screen.visible;
  const frames = await Promise.all(sessions.map(async (s) => (await s.get("host.window")).frame));
  // The rule of the positions is windowPosition of @soksak/window-check, which place() of fresh applies; the check reads it and
  // does not state it again.
  for (const [index, s] of sessions.entries()) {
    const frame = frames[index];
    const position = windowPosition(s.app.name, area, frame);
    assert.deepEqual([frame.x, frame.y], [position.x, position.y], `${s.app.name} is not at its window position in the visible area`);
  }
  // No window covers the position of another one completely.
  const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
  for (const [index, s] of sessions.entries()) {
    for (const [other, o] of sessions.entries()) {
      if (other === index) continue;
      assert.ok(!contains(frames[index], frames[other]),
        `the ${s.app.name} window covers the ${o.app.name} window: ${JSON.stringify(frames)}`);
    }
  }
});

// Only declared diagnostic cohort windows are parked through public moves. A real
// visible baseline must precede the application-owned cover; no activation or
// ordering above a user window is part of the fixture.
for (const app of Object.values(APPS)) {
  test(`${app.name}: a check window that another window covers reports occluded to its watchers`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s);
    const prepared = await uncoverFromCheckWindows(t, s);
    t.diagnostic(`inactive occlusion preparation ${JSON.stringify({ before: {
      frame: prepared.before.frame, occluded: prepared.before.occluded,
      activationObservation: prepared.before.activationObservation }, baseline: {
      frame: prepared.baseline.frame, occluded: prepared.baseline.occluded,
      activationObservation: prepared.baseline.activationObservation }, parked: prepared.parked })}`);
    await keepCommonSettings(s);
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-cover-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the covering project window did not close");
      for (const project of await s.get("core.projects")) {
        if (project.root === root) await s.run("core.project.close", { id: project.id });
      }
    });
    const covered = (await s.get("host.window")).frame;
    await s.run("core.project.open", { root, color: "#7db4ff" });
    const windows = await s.windows(2, "the covering project window did not open");
    const cover = s.on(windows.find((w) => w.window !== s.window).window);
    await cover.run("host.window.resize", { width: covered.width + 200, height: covered.height + 100 });
    await cover.run("host.window.move", { x: covered.x - 100, y: covered.y });
    await s.until("host.window", (w) => w.occluded === true, `${app.name} was not reported occluded under its project window`,
      { timeout: 2000 });
    await cover.close();
    await s.windows(1, "the covering project window did not close");
    await s.until("host.window", (w) => w.occluded === false,
      `${app.name} was still reported occluded after its project window closed`, { timeout: 2000 });
  });
}
