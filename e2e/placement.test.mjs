// 검사 창 자리와 가림 보고: fresh 가 두 검사 앱을 정해진 자리에 두고, 가려진 창은 가림 상태를 감시자에게 알린다.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

test("fresh places the two check windows at their own frames", async (t) => {
  const sessions = [];
  for (const app of Object.values(APPS)) {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    sessions.push(s);
  }
  if (sessions.length < 2) return t.skip("only one check application is selected");
  // 두 창을 같은 자리에 겹친 뒤 fresh 가 각자의 자리로 되돌리는지 본다. 자리 정하기가 정하는 것은 창의 자리뿐이다.
  // 다른 애플리케이션의 창이 검사 창을 가리는지는 자리와 무관하므로 여기서 재지 않는다.
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
  // 두 창은 서로의 자리를 모두 덮지 않는다.
  const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
  assert.ok(!contains(left, right) && !contains(right, left), `one check window covers the other: ${JSON.stringify([left, right])}`);
});

// 앞뒤 순서는 활성화 없이 바꿀 수 없으므로, 각 앱의 창을 그 앱이 새로 연 프로젝트 창으로 덮는다. 새 창은 그 앱의
// 앞 창이 된다. 검사가 활성화한 애플리케이션은 하네스가 검사가 끝날 때 앞서 활성이던 것으로 되돌린다.
for (const app of Object.values(APPS)) {
  test(`${app.name}: a check window that another window covers reports occluded to its watchers`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
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
