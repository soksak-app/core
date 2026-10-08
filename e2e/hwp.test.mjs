// HWP check: an .hwp file opens from the file tree in the plugin whose surface.opens declares hwp, its pages draw, a
// native key edits the body text at the caret, Command-S writes the file, and the surface reads the written file back.
// e2e/fixtures/two-paragraphs.hwp holds the paragraphs "속삭 한글 문서 확인" and "둘째 문단입니다.".
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const FIXTURE = new URL("./fixtures/two-paragraphs.hwp", import.meta.url);
/* The controls of the file tree section in order: the section box, the star, the refresh button and the tree holder. */
const HOLDER = 3;
/* The row height of the tree in points (ui/sections/tree.js of the files plugin repository). */
const ROW = 20;

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
  test(`${app.name}: an hwp file opens from the tree, draws its pages, takes a native key and saves`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const project = await s.get("core.project");
    const folder = `hwp-check-${process.pid}`;
    const path = `${folder}/plan.hwp`;
    const file = join(project.root, path);
    mkdirSync(join(project.root, folder));
    copyFileSync(FIXTURE, file);
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));

    const rowIndex = (tree, row) => tree.entries.findIndex((entry) => entry.path === row);
    const clickRow = async (tree, row) => {
      const holder = await s.rect("core.sidebar.section.control", controlIndex(await s.get("core.sidebars"), "left", "files.tree", HOLDER));
      await s.click(holder.x + holder.width / 2, holder.y + (rowIndex(tree, row) + 0.5) * ROW);
    };
    await s.run("files.refresh");
    let tree = await s.until("files.tree", (value) => rowIndex(value, folder) >= 0, "files.tree did not list the folder");
    await clickRow(tree, folder);
    tree = await s.until("files.tree", (value) => rowIndex(value, path) >= 0, "a click on the folder did not open it");
    await clickRow(tree, path);
    await s.until("files.selection", (value) => value === path, "a click on the file did not select it");
    await s.press("Enter");
    const surfaces = await s.until("core.surfaces", (all) => all.some((x) => x.visible && x.plugin === "hwp" && x.status.phase !== "loading"),
      "Enter on the selected hwp file opened no hwp tab");
    const opened = surfaces.find((x) => x.visible && x.plugin === "hwp");
    assert.equal(opened.status.phase, "ready", `the hwp surface failed: ${opened.status.error}`);
    const surface = opened.surface;
    s.cleanup(async () => {
      const grid = await s.get("core.grid");
      if (!grid.cards.some((card) => (card.tabs ?? []).some((tab) => tab.id === surface))) return;
      const { closed } = await s.run("core.tab.close", { tab: surface });
      if (closed) return;
      const picker = await s.until("core.picker", (value) => value.open, "the close question did not open");
      await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
    });
    const document = await s.until("hwp.document", (value) => value.path === path && value.version !== null,
      "the hwp surface did not read the file", { surface });
    assert.equal(document.format, "hwp");
    assert.ok(document.pages >= 1, `the document has ${document.pages} pages`);
    assert.equal(await s.run("hwp.text", {}, surface), "속삭 한글 문서 확인\n둘째 문단입니다.");
    const pages = await s.rect("hwp.pages", undefined, surface);
    assert.ok(pages.width > 0 && pages.height > 0, `the pages have no area: ${JSON.stringify(pages)}`);

    // A native key at the caret inserts its text; Command-S writes the file, and reading it again keeps the edit.
    await s.run("hwp.caret", { section: 0, paragraph: 1, offset: 0 }, surface);
    await s.run("hwp.focus", {}, surface);
    await s.press("x", { text: "x" });
    await s.until("hwp.document", (value) => value.modified, "a native key did not edit the document", { surface });
    assert.equal(await s.run("hwp.text", {}, surface), "속삭 한글 문서 확인\nx둘째 문단입니다.");
    const before = readFileSync(file);
    await s.press("s", { text: "s", modifiers: ["command"] });
    await s.until("hwp.document", (value) => !value.modified, "Command-S did not save", { surface });
    assert.notDeepEqual(readFileSync(file), before, "the file did not change on disk");
    await s.run("hwp.reload", {}, surface);
    assert.equal(await s.run("hwp.text", {}, surface), "속삭 한글 문서 확인\nx둘째 문단입니다.");
  });
}
