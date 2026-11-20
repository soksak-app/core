// The activity of a project is one record of the application, by project and not by window (docs/spec/activity.md#activity-of-a-project):
// each window shows the activity of a project that another window holds, a project that leaves its window for another keeps no entry of
// the earlier window, and two projects of one window each have their own. The tab of a project is a tab of the layout probe fixture
// (e2e/fixtures/layout-probe), whose status layoutprobe.activity is the activity of its tab; `failed` stands for a terminal that ended
// with a failure.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh, replacePlaceholders, startTab } from "./fixture.mjs";

/** One window of the window list that is not in known. */
const added = (list, known) => list.find((w) => !known.includes(w.window)).window;

/** Sets the activity of the layout probe tab surface, and withdraws it when the check ends while the tab still runs. */
async function setActivity(s, surface, value) {
  await s.until("layoutprobe.activity", (current) => current === null || typeof current === "string",
    `tab ${surface} did not register layoutprobe.activity`, { surface });
  await s.run("layoutprobe.activity", { value }, surface);
}

/** Waits until core.activity of the window s lists the project id with activity, or does not list it for null. */
function projectActivity(s, id, activity, message) {
  return s.until("core.activity", (state) => (state.projects[id]?.activity ?? null) === activity, message);
}

/** The icon of the activity on the project tab of id stands inside that tab (docs/spec/activity.md#drawing). */
async function assertProjectIcon(s, id, label) {
  const index = (await s.get("core.projects")).findIndex((project) => project.id === id);
  assert.ok(index >= 0, `${label}: core.projects does not list ${id}`);
  const tab = await s.rect("core.project-tab", index);
  const icon = await s.rect("core.activity.project", 0);
  assert.ok(icon.x >= tab.x && icon.y >= tab.y && icon.x + icon.width <= tab.x + tab.width && icon.y + icon.height <= tab.y + tab.height,
    `${label}: the activity icon ${JSON.stringify(icon)} is not inside the project tab ${JSON.stringify(tab)}`);
}

/**
 * Opens a second project in the opening mode `opening` from the window s and returns `{project, window, surface}`: the opened project,
 * the session of the window that holds it and the start tab of the project.
 */
async function openSecond(t, s, opening, prefix) {
  await s.run("core.settings.set", { patch: { projectOpening: opening }, scope: "common" });
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  s.cleanup(() => rmSync(root, { recursive: true, force: true }));
  const project = await s.run("core.project.open", { root, color: "#7fe3b0" });
  s.cleanupSteps(
    async () => {
      if ((await s.get("core.projects")).some((item) => item.id === project.id)) await s.run("core.project.close", { id: project.id });
      await s.run("core.projects.flush");
    },
    async () => {
      for (const listed of await s.get("host.windows")) if (listed.window !== s.window) await s.on(listed.window).close();
      await s.windows(1, "the windows of the check did not close");
    },
  );
  let window = s;
  if (opening === "windows") window = s.on(added(await s.windows(2, "the window of the second project did not open"), [s.window]));
  else await s.until("core.project", (shown) => shown?.id === project.id, "the second project was not shown in the window");
  await window.until("core.grid", (grid) => grid?.cards.length > 0, "the cards of the second project did not render");
  await replacePlaceholders(window);
  const { surface } = await startTab(window);
  t.diagnostic(`second project ${project.id} in ${window.window}, tab ${surface}`);
  return { project, window, surface };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the project tab of a project that another window holds shows its activity`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const first = await s.get("core.project");
    const second = await openSecond(t, s, "windows", "soksak-activity-two-");
    await setActivity(second.window, second.surface, "failed");
    await projectActivity(second.window, second.project.id, "failed", "the window that holds the second project did not report failed");
    await projectActivity(s, second.project.id, "failed", "the first window did not report the failed second project");
    await assertProjectIcon(s, second.project.id, "first window");
    const record = await s.get("core.activity");
    assert.equal(record.projects[first.id], undefined, "the first project, which has no activity, is listed");
    assert.deepEqual(record.projects, (await second.window.get("core.activity")).projects, "the two windows report different records");
    await second.window.close();
    await s.windows(1, "the window of the second project did not close");
    await projectActivity(s, second.project.id, null, "the closed window left the entry of its project");
  });

  test(`${app.name}: a project that leaves its window for another keeps no entry of the earlier window`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const second = await openSecond(t, s, "windows", "soksak-activity-move-");
    await setActivity(second.window, second.surface, "running");
    await projectActivity(s, second.project.id, "running", "the first window did not report the running detached project");
    // The project leaves its own window and joins the first window: its window closes and the first window opens it in place.
    await s.run("core.settings.set", { patch: { projectOpening: "tabs" }, scope: "common" });
    await second.window.run("core.projects.flush");
    await second.window.close();
    await s.windows(1, "the window of the detached project did not close");
    await projectActivity(s, second.project.id, null, "the entry of the closed window stayed");
    await s.run("core.project.activate", { id: second.project.id });
    await s.until("core.project", (shown) => shown?.id === second.project.id, "the first window did not show the joined project");
    const { surface } = await startTab(s);
    assert.equal((await s.get("host.windows")).length, 1, "the joined project opened another window");
    await setActivity(s, surface, "failed");
    await projectActivity(s, second.project.id, "failed", "the first window did not report the joined project");
    await assertProjectIcon(s, second.project.id, "joined project");
  });

  test(`${app.name}: two projects of one window each show their own activity`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    const { surface: firstTab } = await fresh(s);
    await keepCommonSettings(s);
    const first = await s.get("core.project");
    const second = await openSecond(t, s, "tabs", "soksak-activity-share-");
    assert.equal(second.window, s, "the second project did not share the window");
    await setActivity(s, second.surface, "failed");
    await projectActivity(s, second.project.id, "failed", "the shown second project did not report failed");
    // The first project is shown again; the second keeps its activity while it is not shown.
    await s.run("core.project.activate", { id: first.id });
    await s.until("core.project", (shown) => shown?.id === first.id, "the first project was not shown again");
    await setActivity(s, firstTab, "attention");
    await s.until("core.activity", (state) => state.projects[first.id]?.activity === "attention"
      && state.projects[second.project.id]?.activity === "failed", "the two projects of the window did not report their own activities");
    const projects = await s.get("core.projects");
    const icons = await Promise.all([0, 1].map((index) => s.rect("core.activity.project", index)));
    const tabs = await Promise.all([first.id, second.project.id].map((id) => s.rect("core.project-tab", projects.findIndex((p) => p.id === id))));
    for (const [index, tab] of tabs.entries()) {
      assert.ok(icons.some((icon) => icon.x >= tab.x && icon.x + icon.width <= tab.x + tab.width),
        `the project tab ${JSON.stringify(tab)} of project ${index + 1} holds no icon among ${JSON.stringify(icons)}`);
    }
    await setActivity(s, firstTab, null);
    await projectActivity(s, first.id, null, "the first project kept its activity after its tab withdrew it");
    assert.equal((await s.get("core.activity")).projects[second.project.id]?.activity, "failed", "the second project lost its activity");
  });
}
