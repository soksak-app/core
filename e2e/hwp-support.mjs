// The helpers of the hwp window checks: the fixture, the file tree controls, the lines of the first page and the editor region.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

export const FIXTURE = new URL("./fixtures/two-paragraphs.hwp", import.meta.url);
/* The controls of the file tree section in order: the section box, the star, the refresh button and the tree holder. */
export const HOLDER = 3;
/* The row height of the tree in points (ui/sections/tree.js of the files plugin repository). */
export const ROW = 20;

export const controlIndex = (sidebars, sidebar, section, at) => {
  let index = 0;
  for (const item of sidebars) {
    for (const value of item.sections) {
      if (item.sidebar === sidebar && value.id === section) return index + at;
      index += value.controls;
    }
  }
  throw new Error(`no section ${section} in ${sidebar}`);
};

export const sha = (text) => createHash("sha256").update(text).digest("hex");

/** The lines of the first page: the glyphs of its SVG text elements, joined in order and split where y changes. */
export async function lines(s, surface) {
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
export async function studio(s, surface) {
  const region = (await s.get("host.window")).documents.find((item) => item.surface === surface && item.document === "studio");
  if (!region?.visible) throw new Error(`the hwp surface ${surface} shows no studio region: ${JSON.stringify(region)}`);
  return region;
}


/**
 * Opens an hwp file of a folder of the project in the editor through the file tree and returns {surface, path, file}. The tab and
 * the folder are removed by the cleanups of the session.
 */
export async function openHwp(s) {
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
  return { surface, path, file };
}
