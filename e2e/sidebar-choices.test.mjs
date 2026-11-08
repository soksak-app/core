// Checks that the tab and the folded sections chosen for each sidebar are saved together with the space and are visible again after reload
// (docs/spec/projects.md#persistence).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { cardSidebar, fresh } from "./fixture.mjs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

for (const app of Object.values(APPS)) {
  test(`${app.name}: a sidebar's selected tab and folded sections survive a reload from the saved space`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // The inner left sidebar of the start card uses the tabs set of the layout probe and the fixed left sidebar its list set.
    const [inner] = await cardSidebar(s, { set: "layoutprobe.tabs" });
    await s.run("core.settings.link", { place: "left", plugin: null, set: "layoutprobe.list", scope: "common" });
    const of = (bars, id) => bars.find((bar) => bar.sidebar === id);
    await s.until("core.sidebars", (bars) => of(bars, inner)?.layout === "tabs" && of(bars, "left")?.layout === "list",
      "the card sidebar and the left sidebar did not draw");

    await s.run("core.sidebar.section.select", { sidebar: inner, section: "layoutprobe.beta" });
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "layoutprobe.follow" });
    const chosen = (bars) => of(bars, inner)?.tab === "layoutprobe.beta"
      && of(bars, "left")?.sections.find((item) => item.id === "layoutprobe.follow")?.folded === true;
    await s.until("core.sidebars", chosen, "the tab and the fold were not applied");
    await s.run("core.projects.flush");

    // The saved space holds the choice.
    const project = await s.get("core.project");
    const record = read(join(dirname(project.root), "projects.json")).projects.find((item) => item.id === project.id);
    const layout = record.spaces.find((space) => space.id === record.activeSpaceId).layout;
    assert.deepEqual(layout.sidebars[inner], { tab: "layoutprobe.beta", folded: [] });
    assert.deepEqual(layout.sidebars.left.folded, ["layoutprobe.follow"]);

    // After the document reloads, the same choice is visible in the saved space.
    const before = (await s.get("core.window.workbench")).start;
    await s.run("host.window.reload");
    await s.until("core.window.workbench", (workbench) => workbench.start !== before && workbench.readyState === "complete",
      "the workbench did not start again");
    await s.until("core.sidebars", chosen, "the reloaded document did not show the saved tab and fold");
  });
}
