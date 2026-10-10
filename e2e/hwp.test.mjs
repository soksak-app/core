// HWP check: an .hwp file opens from the file tree in the plugin whose surface.opens declares hwp, which shows the editor
// of its package in a document region and exchanges messages with it (docs/spec/native-surfaces.md#document-regions).
// A native press places the caret, native keys type and select in the editor, Command-S in the editor writes the file,
// the surface reads the written file back, and a pointer drag selects text. e2e/fixtures/two-paragraphs.hwp holds two short
// paragraphs; the expected rows of glyphs are in the test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** The lines of the first page: the glyphs of its SVG text elements, joined in order and split where y changes. */
async function lines(s, surface) {
  const svg = await s.run("hwp.request", { method: "getPageSvg", params: { page: 0 } }, surface);
  const rows = [];
  let y = null;
  for (const [, top, glyph] of svg.matchAll(/<text x="[^"]*" y="([^"]*)"[^>]*>([^<]*)<\/text>/g)) {
    if (top !== y) rows.push("");
    y = top;
    rows[rows.length - 1] += glyph;
  }
  return rows;
}

/** The document region of the editor in host.window. */
async function studio(s, surface) {
  const region = (await s.get("host.window")).documents.find((item) => item.surface === surface && item.document === "studio");
  if (!region?.visible) throw new Error(`the hwp surface ${surface} shows no studio region: ${JSON.stringify(region)}`);
  return region;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: an hwp file opens from the tree, edits it in the editor with native input and saves`, { timeout: 180000 }, async (t) => {
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
    // The cleanup closes the tab from the moment it exists, so a start that stops leaves no tab for the next check.
    const surfaces = await s.until("core.surfaces", (all) => all.some((x) => x.visible && x.plugin === "hwp"),
      "Enter on the selected hwp file opened no hwp tab");
    const surface = surfaces.find((x) => x.visible && x.plugin === "hwp").surface;
    s.cleanup(async () => {
      const grid = await s.get("core.grid");
      if (!grid.cards.some((card) => (card.tabs ?? []).some((tab) => tab.id === surface))) return;
      const { closed } = await s.run("core.tab.close", { tab: surface });
      if (closed) return;
      const picker = await s.until("core.picker", (value) => value.open, "the close question did not open");
      await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
    });
    // hwp.document reports the step of the start, so a start that stops names its step in the failure.
    const document = await s.until("hwp.document", (value) => value.phase === "ready",
      "the hwp surface did not start", { surface }).catch(async (error) => {
      // A window that another window covers can defer the work of its documents, so the failure states the coverage.
      const window = await s.get("host.window");
      error.message += `; the window ${window.occluded ? "is" : "is not"} occluded and ${window.active ? "is" : "is not"} active`;
      throw error;
    });
    const opened = (await s.get("core.surfaces")).find((x) => x.surface === surface);
    assert.equal(opened.status.phase, "ready", `the hwp surface failed: ${opened.status.error}`);
    assert.equal(document.path, path);
    assert.equal(document.format, "hwp");
    assert.equal(document.pages, 1);
    assert.deepEqual(await lines(s, surface), ["속삭한글문서확인", "둘째문단입니다."]);

    // A press on the page in the region gives the editor the keyboard focus and places its caret.
    const region = await studio(s, surface);
    await s.selectInputSource("com.apple.keylayout.ABC");
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height * 0.8);
    await s.until("host.window", (value) => value.documents.some((item) => item.surface === surface && item.focused),
      "a press in the editor did not give it the keyboard focus");

    // A native key types at the caret, Shift-ArrowLeft selects the typed letter and ArrowRight ends the selection. The
    // menu key equivalents copy and paste reach the editor only in an active application, so the activation-tier
    // checks cover them.
    await s.press("x");
    await s.until("hwp.document", (value) => value.modified, "a native key did not edit the document", { surface });
    await s.press("ArrowLeft", { modifiers: ["shift"] });
    await s.until("hwp.document", (value) => value.selection, "Shift-ArrowLeft selected nothing", { surface });
    assert.equal((await s.run("hwp.request", { method: "getSelectionContext" }, surface)).selectedTextSha256, sha("x"));
    await s.press("ArrowRight");
    await s.until("hwp.document", (value) => !value.selection, "ArrowRight did not end the selection", { surface });

    // A pointer drag from the point of the first press to the left along the same line selects text of that line.
    const line = region.frame.y + region.frame.height * 0.8;
    // Each step waits until the window has presented the previous one, as a person's drag reaches the editor.
    await s.pointer(region.frame.x + region.frame.width / 2, line, "down");
    await s.presented();
    await s.pointer(region.frame.x + region.frame.width * 0.3, line, "drag");
    await s.presented();
    await s.pointer(region.frame.x + region.frame.width * 0.2, line, "drag");
    await s.presented();
    await s.pointer(region.frame.x + region.frame.width * 0.2, line, "up");
    await s.until("hwp.document", (value) => value.selection, "a pointer drag selected nothing", { surface });
    await s.press("ArrowRight");
    await s.until("hwp.document", (value) => !value.selection, "ArrowRight did not end the drag selection", { surface });

    // Command-S in the editor writes the file, and reading it again keeps the typed letter.
    const before = readFileSync(file);
    await s.press("s", { modifiers: ["command"] });
    await s.until("hwp.document", (value) => !value.modified, "Command-S did not save", { surface });
    assert.notDeepEqual(readFileSync(file), before, "the file did not change on disk");
    await s.run("hwp.reload", {}, surface);
    const saved = await lines(s, surface);
    assert.equal(saved.join("").replace("x", ""), "속삭한글문서확인둘째문단입니다.", `the saved text is ${JSON.stringify(saved)}`);
    assert.equal(saved.join("").split("x").length, 2, `the saved text is ${JSON.stringify(saved)}`);

  });
}
