// Editor check: a file opens from the file tree in the plugin whose surface.opens declares its extension, native keys
// edit it and Command-S saves it, a failed save shows the tab error until a save succeeds, the tab keeps its params
// after the page reloads, and closing a modified tab asks before it closes (docs/spec/plugins.md#tab-reports).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

/* The controls of the file tree section in order: the section box, the star, the refresh button and the tree holder. */
const HOLDER = 3;
/* The row height of the tree in points (ui/sections/tree.js of the files plugin repository). */
const ROW = 20;

/** The index among core.sidebar.section.control of the control at of section in sidebar, in document order. */
const controlIndex = (sidebars, sidebar, section, at) => {
  let index = 0;
  for (const item of sidebars) {
    for (const value of item.sections) {
      if (item.sidebar === sidebar && value.id === section) return index + at;
      index += value.controls;
    }
  }
  throw new Error(`no section ${section} in ${sidebar}`);
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: a file opens from the tree in the editor, saves, shows a save error and asks before it closes`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const project = await s.get("core.project");
    const folder = `editor-check-${process.pid}`;
    const path = `${folder}/note.txt`;
    const file = join(project.root, path);
    mkdirSync(join(project.root, folder));
    writeFileSync(file, "alpha\r\nbeta\r\n");
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));

    // The tree lists the folder; a native click opens it and selects the file, and Enter runs core.file.open.
    const rowIndex = (tree, row) => tree.entries.findIndex((entry) => entry.path === row);
    const clickRow = async (tree, row) => {
      const holder = await s.rect("core.sidebar.section.control", controlIndex(await s.get("core.sidebars"), "left", "files.tree", HOLDER));
      const at = rowIndex(tree, row);
      assert.ok(at >= 0, `${row} is not a row of the tree`);
      await s.click(holder.x + holder.width / 2, holder.y + (at + 0.5) * ROW);
    };
    await s.run("files.refresh");
    let tree = await s.until("files.tree", (value) => rowIndex(value, folder) >= 0, "files.tree did not list the folder");
    await clickRow(tree, folder);
    tree = await s.until("files.tree", (value) => rowIndex(value, path) >= 0, "a click on the folder did not open it");
    await clickRow(tree, path);
    await s.until("files.selection", (value) => value === path, "a click on the file did not select it");
    await s.press("Enter");
    // The editor reports ready after it read the file; a surface error ends the wait with its text.
    const editor = await s.until("core.surfaces", (all) => all.some((x) => x.visible && x.plugin === "editor"
      && x.status.phase !== "loading"), "Enter on the selected file opened no editor tab");
    const opened = editor.find((x) => x.visible && x.plugin === "editor");
    assert.equal(opened.status.phase, "ready", `the editor surface failed: ${opened.status.error}`);
    const surface = opened.surface;
    // The editor tab does not outlive the check: a later start would open it on the removed folder. A modified tab
    // asks before it closes, and the cleanup discards its changes.
    s.cleanup(async () => {
      const grid = await s.get("core.grid");
      if (!grid.cards.some((card) => (card.tabs ?? []).some((tab) => tab.id === surface))) return;
      const { closed } = await s.run("core.tab.close", { tab: surface });
      if (closed) return;
      const picker = await s.until("core.picker", (value) => value.open, "the close question did not open");
      await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
    });
    const label = (await s.get("core.grid")).cards.flatMap((card) => card.tabs ?? []).find((tab) => tab.id === surface)?.label;
    assert.equal(label, "note.txt", "the editor tab is not named after its file");
    let document = await s.until("editor.document", (value) => value.path === path && value.version !== null,
      "the editor did not read the file", { surface });
    assert.equal(document.newline, "crlf");
    assert.equal(document.modified, false);
    const tabOf = async () => (await s.get("core.grid")).cards.flatMap((card) => card.tabs ?? []).find((tab) => tab.id === surface);

    // Native keys edit the text, the tab shows modified, and Command-S writes the file with its line breaks.
    await s.run("editor.select", { anchor: 0 }, surface);
    await s.run("editor.focus", {}, surface);
    await s.press("x", { text: "x" });
    await s.until("editor.document", (value) => value.modified, "a native key did not modify the text", { surface });
    assert.equal((await tabOf()).modified, true);
    await s.press("s", { text: "s", modifiers: ["command"] });
    await s.until("editor.document", (value) => !value.modified, "Command-S did not save", { surface });
    assert.equal(readFileSync(file, "utf8"), "xalpha\r\nbeta\r\n");
    assert.equal((await tabOf()).modified, false);

    // A save that the file system refuses shows the tab error; the next save that succeeds removes it.
    s.expectError(/tab error .*: 저장하지 못했습니다 · /);
    chmodSync(file, 0o444);
    s.cleanup(() => chmodSync(file, 0o644));
    await s.press("y", { text: "y" });
    await s.until("editor.document", (value) => value.modified, "the second key did not modify the text", { surface });
    await s.press("s", { text: "s", modifiers: ["command"] });
    await s.until("core.grid", (grid) => grid.cards.some((card) => (card.tabs ?? []).some((tab) => tab.id === surface
      && typeof tab.error === "string" && tab.error.startsWith("저장하지 못했습니다 · "))), "a refused save showed no tab error");
    chmodSync(file, 0o644);
    await s.run("editor.save", {}, surface);
    await s.until("core.grid", (grid) => grid.cards.some((card) => (card.tabs ?? []).some((tab) => tab.id === surface && tab.error === null)),
      "a successful save did not remove the tab error");
    assert.equal(readFileSync(file, "utf8"), "xyalpha\r\nbeta\r\n");

    // The tab keeps its params after the page reloads, and the editor reads the same file again.
    const before = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
      "the main document did not reload");
    await s.until("core.surfaces", (all) => all.some((x) => x.surface === surface && x.status.phase === "ready"),
      "the editor tab did not open again after the reload");
    await s.until("editor.document", (value) => value.path === path && value.version !== null,
      "the editor tab did not read its file after the reload", { surface });

    // Closing a modified tab asks; 닫지 않기 keeps it, and 저장하지 않고 닫기 closes it without writing.
    await s.run("editor.edit", { changes: [{ from: 0, to: 0, insert: "z" }] }, surface);
    document = await s.until("editor.document", (value) => value.modified, "editor.edit did not modify the text", { surface });
    assert.deepEqual(await s.run("core.tab.close", { tab: surface }), { closed: false });
    const ask = async () => (await s.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "closing a modified tab did not ask")).items.map((item) => item.name);
    assert.deepEqual(await ask(), ["저장하고 닫기", "저장하지 않고 닫기", "닫지 않기"]);
    await s.run("core.picker.pick", { index: 2 });
    await s.until("core.picker", (picker) => !picker.open, "닫지 않기 did not close the question");
    assert.ok(await tabOf(), "닫지 않기 closed the tab");
    await s.run("core.tab.close", { tab: surface });
    await ask();
    await s.run("core.picker.pick", { index: 1 });
    await s.until("core.grid", (grid) => !grid.cards.some((card) => (card.tabs ?? []).some((tab) => tab.id === surface)),
      "저장하지 않고 닫기 did not close the tab");
    assert.equal(readFileSync(file, "utf8"), "xyalpha\r\nbeta\r\n");
  });
}
