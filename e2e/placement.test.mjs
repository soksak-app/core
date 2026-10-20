// Position of the check windows and the report of covering: fresh puts the two check applications at fixed positions, and a covered window tells the observer its covered state.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open, requiresBoth } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

// The check places two windows, so it is registered only when the required set holds both applications.
if (requiresBoth(process.env)) test("fresh places the two check windows at their own frames", async (t) => {
  const sessions = [];
  for (const app of Object.values(APPS)) {
    const s = await open(t, app);
    sessions.push(s);
  }
  // Overlaps both windows at the same position and then checks that fresh returns each to its own position. Positioning sets only the position of the window.
  // Whether a window of another application covers a check window does not depend on the position, so this check does not measure it.
  const { frame } = await sessions[0].get("host.window");
  await sessions[1].run("host.window.move", { x: frame.x, y: frame.y });
  await sessions[1].until("host.window", (w) => w.frame.x === frame.x && w.frame.y === frame.y, "the second window did not move onto the first");
  for (const s of sessions) await fresh(s);
  const [screen] = await sessions[0].get("host.screens");
  const area = screen.visible;
  const [left, right] = await Promise.all(sessions.map(async (s) => (await s.get("host.window")).frame));
  assert.deepEqual([left.x, left.y], [area.x, area.y], `${sessions[0].app.name} is not at the top left of the visible area`);
  assert.deepEqual([right.x + right.width, right.y], [area.x + area.width, area.y],
    `${sessions[1].app.name} is not at the top right of the visible area`);
  // The two windows do not cover each other's position completely.
  const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
  assert.ok(!contains(left, right) && !contains(right, left), `one check window covers the other: ${JSON.stringify([left, right])}`);
});

// The front-to-back order cannot be changed without activation, so the window of each application is covered by the project window that the application newly opened. The new window becomes the front window of that application.
// The application that the check activated is restored by the harness, when the check ends, to the one that was active before.
for (const app of Object.values(APPS)) {
  test(`${app.name}: a check window that another window covers reports occluded to its watchers`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
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
