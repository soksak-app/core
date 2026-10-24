// The helpers of the hwp window checks: the fixture, the file tree controls, the lines of the first page and the editor region.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { declaredSidebarControlIndex } from "./declared-sidebar-control.mjs";

export const FIXTURE = new URL("./fixtures/two-paragraphs.hwp", import.meta.url);
export const sha = (text) => createHash("sha256").update(text).digest("hex");

const filesTree = (snapshot) => snapshot.value?.elements.find((element) => element.kind === "tree" && element.key === "files");

const treeNode = (snapshot, path) => {
  const find = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.params?.path === path) return node;
      const nested = find(node.children);
      if (nested) return nested;
    }
    return null;
  };
  return find(filesTree(snapshot)?.nodes);
};

const treePath = (snapshot, path) => {
  const tree = filesTree(snapshot);
  const find = (nodes, parents = []) => {
    for (const node of nodes ?? []) {
      const keys = [...parents, node.key];
      if (node.params?.path === path) return keys;
      const nested = find(node.children, keys);
      if (nested) return nested;
    }
    return null;
  };
  return find(tree?.nodes);
};

const treeAddress = (snapshot, path, role = "label") => {
  const tree = filesTree(snapshot);
  assert.ok(tree, "files.tree has no declared tree element");
  const keys = treePath(snapshot, path);
  assert.ok(keys, `${path} is not a node of the declared tree`);
  return { sidebar: "left", section: "files.tree", key: tree.key, path: keys, role };
};

const clickTreeControl = async (s, address) => {
  const rect = await s.request("dom.rect", { name: "core.sidebar.section.control", address });
  assert.ok(rect.width > 0 && rect.height > 0, `control ${JSON.stringify(address)} has no area`);
  await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
};

const acceptedTreeSeq = async (s) => {
  const sidebars = await s.get("core.sidebars");
  const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
  assert.ok(Number.isInteger(section?.acceptedSeq), "the Files section has no accepted snapshot sequence");
  return section.acceptedSeq;
};

const treeAfterAcceptedPush = async (s, sequence, predicate, message) => {
  let accepted = sequence;
  for (;;) {
    const sidebars = await s.until("core.sidebars", (value) => {
      const section = value.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
      return Number.isInteger(section?.acceptedSeq) && section.acceptedSeq > accepted ? section.acceptedSeq : undefined;
    }, message);
    accepted = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree").acceptedSeq;
    const snapshot = await s.get("files.tree");
    if (predicate(snapshot)) return snapshot;
  }
};

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
  assert.equal(await s.run("files.refresh"), null);
  let tree = await s.get("files.tree");
  assert.ok(treePath(tree, folder), `files.tree did not list the folder ${folder}`);
  await s.until("core.sidebars", (sidebars) => {
    const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
    return section?.mounted && section.controls > 0;
  }, "the Files tree section did not render the project snapshot");
  tree = await s.get("files.tree");

  let sequence = await acceptedTreeSeq(s);
  await clickTreeControl(s, treeAddress(tree, folder, "label"));
  tree = await treeAfterAcceptedPush(s, sequence,
    (snapshot) => treeNode(snapshot, folder)?.selected === true,
    "the folder label did not publish its selection");
  sequence = await acceptedTreeSeq(s);
  await clickTreeControl(s, treeAddress(tree, folder, "expand"));
  tree = await treeAfterAcceptedPush(s, sequence,
    (snapshot) => treeNode(snapshot, folder)?.expanded === true && Boolean(treePath(snapshot, path)),
    "the folder expand control did not publish its expanded tree");
  assert.ok(treePath(tree, path), `the expanded folder did not list ${path}`);

  sequence = await acceptedTreeSeq(s);
  const fileLabelAddress = treeAddress(tree, path, "label");
  await clickTreeControl(s, fileLabelAddress);
  tree = await treeAfterAcceptedPush(s, sequence,
    (snapshot) => treeNode(snapshot, path)?.selected === true,
    "the file label did not publish its selection");
  assert.equal(treeNode(tree, path)?.selected, true, "the file label did not select the HWP file");
  const fileLabelIndex = await declaredSidebarControlIndex(s, fileLabelAddress);
  assert.equal(await s.run("core.focus.set", { name: "core.sidebar.section.control", index: fileLabelIndex }), null);
  await s.until("core.focus", (focus) => focus?.name === "core.sidebar.section.control" && focus.index === fileLabelIndex,
    "core.focus.set did not focus the selected file label");
  await s.press("Enter");
  // The cleanup closes the tab from the moment it exists, so a start that stops leaves no tab for the next check.
  const surfaces = await s.until("core.surfaces", (all) => all.some((x) => x.visible && x.plugin === "hwp"),
    "Enter on the focused file label opened no hwp tab");
  const surface = surfaces.find((x) => x.visible && x.plugin === "hwp").surface;
  s.cleanup(async () => {
    const grid = await s.get("core.grid");
    if (!grid.cards.some((card) => (card.tabs ?? []).some((tab) => tab.id === surface))) return;
    const { closed } = await s.run("core.tab.close", { tab: surface });
    if (closed) return;
    const picker = await s.until("core.picker", (value) => value.open, "the close question did not open");
    await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
  });
  await s.until("core.surfaces", (all) => all.some((item) => item.surface === surface && item.visible &&
    item.exposes?.includes("status hwp.document")),
  "the hwp surface did not register status hwp.document");
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
