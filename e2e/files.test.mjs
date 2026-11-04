// Files section views check: the files sections of a sidebar are section surfaces that mount with their document and run the
// files commands on their own surface, and a file that the tree view opens with no plugin for it stays out of the error display.
// The rows and bookmark entries that the views draw are not observable through the core exposure, because the files plugin
// declares no status or element entry for them. The checks that need them are held until the plugin declares them (docs/features.md, F332-4-4).
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";

const FILES_SECTIONS = ["files.tree", "files.bookmarks"];

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
  test(`${app.name}: the files sections of the left sidebar mount as section surfaces and run the files commands on their surface`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const project = await s.get("core.project");
    const folder = `files-check-${process.pid}`;
    const directory = join(project.root, folder);
    mkdirSync(directory);
    writeFileSync(join(directory, "note.txt"), "note\n");
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    const note = `${folder}/note.txt`;

    // A section surface id is qualified by the shown space (docs/spec/plugins.md#sections).
    const space = (await s.get("core.project")).activeSpaceId;
    await s.until("core.sidebars", (sidebars) => FILES_SECTIONS.every((id) => {
      const section = sectionOf(sidebars, "left", id);
      return section?.mounted === true && section.phase === "ready" && section.error === null && section.surfaceId === `${space}/left/${id}`;
    }), "the files sections of the left sidebar did not mount and report ready");
    const surfaces = await s.get("core.surfaces");
    const surfaceIds = FILES_SECTIONS.map((id) => `${space}/left/${id}`);
    for (const surface of surfaceIds) {
      const entry = sectionSurface(surfaces, surface);
      assert.ok(entry, `core.surfaces does not list the section surface ${surface}`);
      assert.equal(entry.sidebar, "left", `${surface} is not a section of the left sidebar`);
      assert.equal(entry.plugin, "files", `${surface} is not a surface of the files plugin`);
    }
    await documentsReady(s, surfaceIds);

    // The tree section lists the project folder after files.refresh, which the tree surface runs and answers with null.
    assert.equal(await s.run("files.refresh", {}, surfaceIds[0]), null);
    // A bookmark that the tree surface adds is removed through the bookmarks surface.
    assert.equal(await s.run("files.bookmarks.add", { path: note }, surfaceIds[0]), null);
    assert.equal(await s.run("files.bookmarks.remove", { path: note }, surfaceIds[1]), null);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a files tree section mounts in a card sidebar beside the left sidebar's tree of the same project`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await s.until("core.project", (value) => value?.root, "the fixture project was not shown");
    await terminalCardSidebar(s, { sections: ["files.tree"] });
    const space = (await s.get("core.project")).activeSpaceId;
    const surfaceIds = [`${space}/left/files.tree`, `${space}/terminal:left/files.tree`];
    await s.until("core.sidebars", (sidebars) => sectionOf(sidebars, "left", "files.tree")?.mounted === true
      && sectionOf(sidebars, "terminal:left", "files.tree")?.mounted === true
      && sectionOf(sidebars, "left", "files.tree")?.phase === "ready" && sectionOf(sidebars, "terminal:left", "files.tree")?.phase === "ready",
    "the two files tree sections did not mount and report ready");
    const surfaces = await s.get("core.surfaces");
    assert.deepEqual(surfaceIds.map((surface) => sectionSurface(surfaces, surface)?.sidebar), ["left", "terminal:left"],
      "core.surfaces does not list one files tree section surface per sidebar");
    await documentsReady(s, surfaceIds);
    for (const surface of surfaceIds) {
      assert.equal(await s.run("files.refresh", {}, surface), null, `files.refresh on ${surface} did not complete`);
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a file that no plugin opens from the files tree section stays out of the error display`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // Without the editor, which opens every file, no plugin opens the files of the check. Each change of the plugin reloads the window.
    const start = async () => (await s.get("core.window.workbench")).start;
    const reloaded = async (before, message) => {
      await s.until("core.window.workbench", (value) => value.start !== before && value.readyState === "complete", message);
      await s.until("host.windows", (list) => list.some((item) => item.window === s.window && item.ready), `${message}: the new workbench did not report ready`);
    };
    const initialPlugins = await s.get("core.plugins");
    const editorBefore = initialPlugins.plugins.find((row) => row.id === "editor");
    assert.ok(editorBefore, "core.plugins did not list editor before the failure check");
    assert.equal(editorBefore.state, "loaded", "editor must be loaded before the failure check");
    assert.equal(editorBefore.installed.enabled, true, "editor must be enabled before the failure check");
    s.cleanup(async () => {
      const current = (await s.get("core.plugins")).plugins.find((row) => row.id === "editor");
      assert.ok(current, "core.plugins did not list editor during failure cleanup");
      if (current.installed.enabled === editorBefore.installed.enabled) return;
      const before = await start();
      const action = editorBefore.installed.enabled ? "enable" : "disable";
      await s.run(`core.plugins.${action}`, { plugin: "editor" });
      await reloaded(before, `${action} editor did not reload the window during cleanup`);
      await s.until("core.plugins", (value) => {
        const row = value.plugins.find((item) => item.id === "editor");
        return row?.state === editorBefore.state
          && row.installed?.enabled === editorBefore.installed.enabled
          && value.reload === false;
      }, `editor did not return to its initial state during cleanup`);
    });
    const beforeDisable = await start();
    await s.run("core.plugins.disable", { plugin: "editor" });
    await reloaded(beforeDisable, "disabling editor did not reload the window");
    const disabled = await s.until("core.plugins", (value) => {
      const row = value.plugins.find((item) => item.id === "editor");
      return row?.state === "disabled" && row.installed?.enabled === false && value.reload === false;
    }, "the reloaded page did not report editor disabled");
    assert.equal(disabled.plugins.find((row) => row.id === "editor").state, "disabled");

    const project = await s.get("core.project");
    const folder = `files-open-check-${process.pid}`;
    mkdirSync(join(project.root, folder));
    writeFileSync(join(project.root, folder, "note.zzz"), "note\n");
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));
    await s.until("core.sidebars", (sidebars) => sectionOf(sidebars, "left", "files.tree")?.phase === "ready",
      "the files tree section view was not ready before the open");
    const tree = `${project.activeSpaceId}/left/files.tree`;
    await s.run("files.refresh", {}, tree);
    // files.open answers null when no plugin opens the file: the tree view shows the failure, so the error display stays empty.
    assert.equal(await s.run("files.open", { path: `${folder}/note.zzz` }, tree), null);
    assert.equal(await s.get("core.workbench.error"), null, "the failure to open a file reached the error display");
  });
}
