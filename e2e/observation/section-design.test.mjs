// Leaves stills of the files and browser sections in light and dark modes for inspection at original resolution
// (docs/operations/examples.md#window-checks). An image is an observation and no result of a check; the check fails when
// a section does not mount or reports an error.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, terminalCardSidebar } from "../fixture.mjs";

const OUTPUT = new URL("../../target/section-design/", import.meta.url).pathname;

/** Waits until the sidebar shows the set with every section mounted and free of errors. */
async function shown(s, sidebar, sections) {
  await s.until("core.sidebars", (bars) => {
    const bar = bars.find((item) => item.sidebar === sidebar);
    return bar && sections.every((id) => bar.sections.find((item) => item.id === id)?.mounted)
      && bar.sections.every((item) => item.error === null);
  }, `${sidebar} did not mount ${sections.join(", ")}`);
}

for (const app of Object.values(APPS))
  test(`${app.name}: stills of the files and browser sections in each mode`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await terminalCardSidebar(s);
    const project = await s.until("core.project", (value) => value?.root, "the fixture project was not shown");
    const folder = mkdtempSync(join(project.root, "design-"));
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    for (const name of ["alpha.txt", "beta.md", "gamma.json"]) writeFileSync(join(folder, name), "text\n");
    await shown(s, "terminal:left", ["files.tree", "files.bookmarks"]);
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "terminal card absent");
    await s.run("core.card.sidebar.set", { card: card.id, side: "right", set: "set-browser" });
    await shown(s, `${card.id}:right`, ["browser.tabs"]);
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
