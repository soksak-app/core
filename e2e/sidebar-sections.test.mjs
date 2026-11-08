// Sidebar section check on the layout probe fixture (e2e/fixtures/layout-probe): a section of a card sidebar mounts as its own
// section surface beside the same section of the window sidebar, and a file that no plugin opens, which a view asks core.file.open
// for, returns the failure to that view and stays out of the error display.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { cardSidebar, fresh } from "./fixture.mjs";

/** The section that both sidebars show: the first section of the list set `layoutprobe.list` of the layout probe. */
const SECTION = "layoutprobe.alpha";

/** The section entry of the sidebar in core.sidebars, or undefined when the sidebar does not draw it. */
const sectionOf = (sidebars, sidebar, id) => sidebars.find((item) => item.sidebar === sidebar)?.sections.find((item) => item.id === id);

/** The section surface of core.surfaces with the surface id, or null. */
const sectionSurface = (surfaces, surface) => surfaces.find((item) => item.kind === "section" && item.surface === surface) ?? null;

/** Waits until the document of each section surface finished its load and applied its theme. */
async function documentsReady(s, surfaces) {
  for (const surface of surfaces) {
    await s.until("core.surface.document", (doc) => doc !== null && doc.readyState === "complete" && doc.themed,
      `${surface} did not finish its document`, { surface });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a section mounts in a card sidebar beside the same section of the window sidebar`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { plugin } = await fresh(s);
    await s.until("core.project", (value) => value?.root, "the fixture project was not shown");
    await keepCommonSettings(s);
    await s.run("core.settings.set", { patch: { left: true }, scope: "common" });
    await s.run("core.settings.link", { place: "left", plugin: null, set: `${plugin}.list`, scope: "common" });
    const [cardLeft] = await cardSidebar(s, { sections: [SECTION] });
    const card = cardLeft.slice(0, -":left".length);
    const space = (await s.get("core.project")).activeSpaceId;
    // A section surface id is qualified by the shown space (docs/spec/plugins.md#sections).
    const sidebars = ["left", cardLeft];
    const surfaceIds = sidebars.map((sidebar) => `${space}/${sidebar}/${SECTION}`);
    await s.until("core.sidebars", (value) => sidebars.every((sidebar) => {
      const section = sectionOf(value, sidebar, SECTION);
      return section?.mounted === true && section.phase === "ready" && section.error === null;
    }), `the two ${SECTION} sections did not mount and report ready`);
    const surfaces = await s.get("core.surfaces");
    assert.deepEqual(surfaceIds.map((surface) => sectionSurface(surfaces, surface)?.sidebar), sidebars,
      `core.surfaces does not list one ${SECTION} section surface per sidebar`);
    for (const surface of surfaceIds) assert.equal(sectionSurface(surfaces, surface).plugin, plugin, `${surface} is not a surface of ${plugin}`);
    await documentsReady(s, surfaceIds);
    // Each section view reports the section, sidebar and card of its own start values.
    for (const [index, surface] of surfaceIds.entries()) {
      await s.until("layoutprobe.section", (value) => value?.id === SECTION && value.sidebar === sidebars[index]
        && value.card === (index === 0 ? null : card), `${surface} did not report its own section`, { surface });
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a file that no plugin opens from a view stays out of the error display`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    const project = await s.get("core.project");
    const folder = `open-check-${process.pid}`;
    const path = `${folder}/note.zzz`;
    mkdirSync(join(project.root, folder));
    writeFileSync(join(project.root, path), "note\n");
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));
    // No loaded fixture plugin declares the extension zzz, so core.file.open, which the view runs, fails, and the view receives the
    // failure as the answer of its call.
    const before = new Set((await s.get("core.grid")).cards.flatMap((card) => (card.tabs ?? []).map((tab) => tab.id)));
    const answer = await s.run("layoutprobe.open", { path }, surface);
    assert.deepEqual(answer, { tab: null, error: `no plugin opens ${path}` }, "the view did not receive the failure of core.file.open");
    assert.equal(await s.get("core.workbench.error"), null, "the failure to open a file reached the error display");
    const after = (await s.get("core.grid")).cards.flatMap((card) => (card.tabs ?? []).map((tab) => tab.id));
    assert.deepEqual(after.filter((tab) => !before.has(tab)), [], "the failed open added a tab");
  });
}
