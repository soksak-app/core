// Files section views check: the files sections of a sidebar are section surfaces that mount with their document and run the
// files commands on their own surface, a file that the tree view opens with no plugin for it stays out of the error display, a
// double click on a row opens its file, and the bookmarks of the project data keep two adds at once and reach the next window of
// the project. The tree view reports its visible rows in its status `files.tree` and exposes each row as the element
// `files.tree.row`, in the same order.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// A double click on a file row of the files tree opens the file in an editor tab, as it does for a person: the pointer of the
// application presses twice with the click counts 1 and 2, so the page receives the dblclick that AppKit makes of a person's
// double click (docs/spec/exposure.md). The pointer move makes the window the virtual key window and activates nothing.
for (const app of Object.values(APPS)) {
  test(`${app.name}: a double click on a file row of the files tree opens the file in an editor tab`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const project = await s.get("core.project");
    const folder = `files-double-click-${process.pid}`;
    const path = `${folder}/note.txt`;
    mkdirSync(join(project.root, folder));
    writeFileSync(join(project.root, path), "double click\n");
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));
    await s.until("core.sidebars", (sidebars) => sectionOf(sidebars, "left", "files.tree")?.phase === "ready",
      "the files tree section view was not ready");
    const tree = `${project.activeSpaceId}/left/files.tree`;
    await documentsReady(s, [tree]);
    await s.run("files.refresh", {}, tree);
    await s.until("files.tree", (value) => value.rows.some((row) => row.path === folder), `the tree did not list ${folder}`, { surface: tree });
    await s.run("files.tree.toggle", { path: folder, expanded: true }, tree);
    const { rows } = await s.until("files.tree", (value) => value.rows.some((row) => row.path === path),
      `the tree did not list ${path} after the folder expanded`, { surface: tree });
    const index = rows.findIndex((row) => row.path === path);
    const before = new Set((await s.get("core.grid")).cards.flatMap((card) => (card.tabs ?? []).map((tab) => tab.id)));
    s.cleanup(async () => {
      for (const card of (await s.get("core.grid")).cards) {
        for (const tab of card.tabs ?? []) if (!before.has(tab.id)) await s.run("core.tab.close", { tab: tab.id });
      }
    });
    const rect = await s.rect("files.tree.row", index, tree);
    const x = rect.document.x + rect.x + Math.min(40, rect.width / 2);
    const y = rect.document.y + rect.y + rect.height / 2;
    const active = (await s.get("host.window")).active;
    await s.pointer(x, y, "move");
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    for (const clicks of [1, 2]) {
      await s.pointer(x, y, "down", { clicks });
      await s.pointer(x, y, "up", { clicks });
    }
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => (card.tabs ?? []).some((tab) => !before.has(tab.id))),
      "the double click opened no tab");
    const opened = grid.cards.flatMap((card) => card.tabs ?? []).filter((tab) => !before.has(tab.id));
    assert.equal(opened.length, 1, `the double click opened ${opened.length} tabs: ${JSON.stringify(opened)}`);
    await s.until("editor.document", (value) => value.path === path, `the opened tab does not show ${path}`, { surface: opened[0].id });
    assert.equal((await s.get("host.window")).active, active, `the double click changed whether ${app.name} is active`);
  });
}

// Two views of the files plugin add a bookmark at the same moment, and the project data keeps both (docs/spec/plugins.md#project-data).
for (const app of Object.values(APPS)) {
  test(`${app.name}: two bookmarks that two views add at the same moment both stay`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const project = await s.get("core.project");
    const folder = `files-bookmarks-${process.pid}`;
    const paths = [`${folder}/one.txt`, `${folder}/two.txt`];
    mkdirSync(join(project.root, folder));
    for (const path of paths) writeFileSync(join(project.root, path), `${path}\n`);
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));
    // The tree of the left sidebar and the tree of a card sidebar are two views of the same project that add bookmarks.
    await terminalCardSidebar(s, { sections: ["files.tree"] });
    const space = project.activeSpaceId;
    const trees = [`${space}/left/files.tree`, `${space}/terminal:left/files.tree`];
    const bookmarks = `${space}/left/files.bookmarks`;
    await s.until("core.sidebars", (sidebars) => sectionOf(sidebars, "left", "files.tree")?.phase === "ready"
      && sectionOf(sidebars, "terminal:left", "files.tree")?.phase === "ready" && sectionOf(sidebars, "left", "files.bookmarks")?.phase === "ready",
    "the two files trees and the bookmarks did not report ready");
    await documentsReady(s, [...trees, bookmarks]);
    s.cleanup(async () => {
      for (const path of paths) await s.run("files.bookmarks.remove", { path }, bookmarks);
    });
    await Promise.all(paths.map((path, index) => s.run("files.bookmarks.add", { path }, trees[index])));
    const stored = await s.until("files.bookmarks", (value) => paths.every((path) => value.includes(path)),
      "the bookmarks did not keep both adds", { surface: bookmarks });
    assert.equal(stored.filter((path) => paths.includes(path)).length, 2, `the bookmarks hold ${JSON.stringify(stored)}`);
  });
}

// A bookmark that one window wrote reaches the views of the window that opens the project after it: only one window holds a
// project, so the project closes with its window and opens again in a new window (docs/spec/projects.md).
for (const app of Object.values(APPS)) {
  test(`${app.name}: a bookmark that one window wrote reaches the window that opens the project after it`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-files-window-")));
    writeFileSync(join(root, "note.txt"), "note\n");
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanup(async () => {
      for (const window of await s.get("host.windows")) {
        if (window.window !== s.window) await s.on(window.window).close();
      }
      await s.windows(1, "the check left an extra window");
      for (const project of await s.get("core.projects")) {
        if (project.root.startsWith(root)) await s.run("core.project.close", { id: project.id });
      }
      await s.run("core.projects.flush");
    });
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    const projectWindow = async (color) => {
      const opened = await s.run("core.project.open", { root, color });
      const windows = await s.windows(2, "the project window did not open");
      const child = s.on(windows.find((item) => item.window !== s.window).window);
      const project = await child.until("core.project", (value) => value?.id === opened.id, "the project did not become active");
      const [tree, bookmarks] = FILES_SECTIONS.map((id) => `${project.activeSpaceId}/left/${id}`);
      await child.until("core.sidebars", (sidebars) => FILES_SECTIONS.every((id) => sectionOf(sidebars, "left", id)?.phase === "ready"),
        "the files sections of the project window did not report ready");
      await documentsReady(child, [tree, bookmarks]);
      return { child, tree, bookmarks };
    };
    const first = await projectWindow("#7fe3b0");
    await first.child.run("files.bookmarks.add", { path: "note.txt" }, first.tree);
    await first.child.until("files.bookmarks", (value) => value.includes("note.txt"), "the first window did not store the bookmark",
      { surface: first.bookmarks });
    await first.child.close();
    await s.windows(1, "the first project window did not close");
    const second = await projectWindow("#7db4ff");
    await second.child.until("files.bookmarks", (value) => value.includes("note.txt"),
      "the window that opened the project after the first did not read its bookmark", { surface: second.bookmarks });
  });
}
