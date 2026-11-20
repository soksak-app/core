// Leaves stills of the activity icons of a tab, a group header, a space tab and a project tab in light and dark modes for inspection
// at original resolution (docs/operations/examples.md#window-checks, docs/spec/activity.md#drawing). The tabs are those of the layout
// probe fixture (e2e/fixtures/layout-probe), whose status layoutprobe.activity reports the activity of its tab: the start card holds
// a tab that waits for the person and one that runs, and the group card that core.group.create makes around it and a new card beside
// it holds in that new card a tab that failed and one that is idle. An image is an observation and no result of a check; the check fails when core.activity does not report the activities that
// the tabs set.
import { copyFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";

const OUTPUT = new URL("../../target/activity-icons/", import.meta.url).pathname;

for (const app of Object.values(APPS))
  test(`${app.name}: stills of the activity icons in each mode`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    const { surface, plugin } = await fresh(s);
    const card = (await s.get("core.grid")).cards.find((entry) => entry.tabs.some((tab) => tab.id === surface)).id;
    const { tab: running } = await s.run("core.card.add-tab", { card, plugin });
    const group = await s.run("core.group.create", { card, side: "right", plugin });
    const { tab: idle } = await s.run("core.card.add-tab", { card: group.card, plugin });
    const values = { [surface]: "attention", [running]: "running", [group.tab]: "failed", [idle]: "idle" };
    for (const [tab, value] of Object.entries(values)) {
      await s.until("layoutprobe.activity", (current) => current === null, `tab ${tab} did not register layoutprobe.activity`, { surface: tab });
      await s.run("layoutprobe.activity", { value }, tab);
      s.cleanup(() => s.run("layoutprobe.activity", { value: null }, tab));
    }
    const project = await s.get("core.project");
    await s.until("core.activity", (state) => state.tabs[surface] === "attention" && state.tabs[running] === "running"
      && state.tabs[group.tab] === "failed" && state.tabs[idle] === "idle"
      && state.projects[project.id]?.spaces[project.activeSpaceId]?.cards[group.card] === "failed"
      && state.projects[project.id]?.spaces[project.activeSpaceId]?.groups[group.group] === "attention"
      && state.projects[project.id]?.activity === "attention", "core.activity did not report the activities of the tabs");
    mkdirSync(OUTPUT, { recursive: true });
    for (const mode of ["light", "dark"]) {
      await s.run("core.settings.set", { patch: { mode } });
      await s.until("core.settings", (value) => value.values.mode === mode, `the mode did not become ${mode}`);
      await s.presented();
      const { path } = await s.request("diagnostics.capture.still", {});
      s.cleanup(() => rmSync(dirname(path), { recursive: true, force: true }));
      copyFileSync(path, join(OUTPUT, `${app.name}-${mode}.png`));
      unlinkSync(path);
      t.diagnostic(`still ${join(OUTPUT, `${app.name}-${mode}.png`)}`);
    }
  });
