// Checks that a view newly opened in a project starts at the canonical root of the project (docs/spec/projects.md). The view is a
// tab of the layout probe, which reports the project and the origin directory that it was given and the directory it starts in.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

/**
 * Adds a tab of plugin to the card of the start layout that does not hold the start tab and returns its surface. The tabs of the
 * start layout report no directory, so the new tab has no origin directory.
 */
async function addTab(s, start, plugin) {
  const card = (await s.get("core.grid")).cards.find((item) => item.pane !== null && item.tabs.length > 0
    && !item.tabs.some((tab) => tab.id === start));
  assert.ok(card, "the start layout has no second card with tabs");
  const { tab } = await s.run("core.card.add-tab", { card: card.id, plugin });
  s.cleanup(() => s.run("core.tab.close", { tab }));
  await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
    item.surface === tab && item.visible && item.status.phase === "ready"),
  `the new ${plugin} tab did not become ready`);
  return tab;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a new view in a project starts in the project root`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { surface, plugin } = await fresh(s);
    // The check project is under $TMPDIR and resolves through /private, so the check compares canonical paths.
    const project = await s.get("core.project");
    const root = realpathSync(project.root);

    const view = await addTab(s, surface, plugin);
    const started = await s.until("layoutprobe.view", (value) => value?.surface === view,
      "the new view reported no start values", { surface: view });
    assert.equal(started.origin.directory, null, `the new view has an origin directory: ${JSON.stringify(started.origin)}`);
    assert.equal(started.project?.id, project.id, `the new view was given another project: ${JSON.stringify(started.project)}`);
    assert.equal(realpathSync(started.project.root), root, `the new view was given the project root ${started.project.root}`);
    assert.equal(realpathSync(started.directory), root, `the new view started in ${started.directory}`);
  });
}
