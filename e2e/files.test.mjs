// Files plugin check: declared UI snapshots draw the project folder and bookmarks in sidebar sections, native clicks operate the tree,
// and core sidebar notifications report rendered updates while plugin-host snapshots are pulled through status.get.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, coveredBy, open } from "@soksak/window-check/app.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";
import { distance, readPng } from "@soksak/window-check/png.mjs";

/** Presses the center of the element with native input. */
const press = async (s, name, index) => {
  const rect = await s.rect(name, index);
  assert.ok(rect.width > 0 && rect.height > 0, `${name} ${index} has no area`);
  await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
};

/** The index of the at-th interactive element that the section of sidebar drew, among core.sidebar.section.control in document order. */
const controlIndex = (sidebars, sidebar, section, at) => {
  let index = 0;
  for (const item of sidebars) {
    for (const value of item.sections) {
      if (item.sidebar === sidebar && value.id === section) {
        assert.ok(at < value.controls, `${sidebar} ${section} has ${value.controls} controls`);
        return index + at;
      }
      index += value.controls;
    }
  }
  throw new Error(`no section ${section} in ${sidebar}`);
};

/* Order of the interactive elements of the file tree section: the section box that receives the selection, the star, refresh, and the element that holds the tree. */
const STAR = 1;
const REFRESH = 2;
const HOLDER = 3;
/* Height (pt) of a tree row. It is the row height of the sidebar list (ui/sections/tree.js of the files plugin repository). */
const ROW = 20;

for (const app of Object.values(APPS)) {
  test(`${app.name}: the files sections show the project folder and its bookmarks from the files state`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const project = await s.get("core.project");
    const folder = `files-check-${process.pid}`;
    const directory = join(project.root, folder);
    mkdirSync(directory);
    writeFileSync(join(directory, "note.txt"), "note\n");
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    const text = (sidebars, id) => sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === id)?.text;
    const filesTree = (snapshot) => snapshot.value?.elements.find((element) => element.kind === "tree" && element.key === "files");
    const treeRows = (snapshot) => {
      const flatten = (nodes) => (nodes ?? []).flatMap((node) => [node, ...flatten(node.children)]);
      return flatten(filesTree(snapshot)?.nodes);
    };
    const treeNode = (snapshot, path) => {
      return treeRows(snapshot).find((node) => node.params?.path === path) ?? null;
    };
    const bookmarkPaths = (snapshot) => snapshot.value?.elements
      .flatMap((element) => element.kind === "list" ? element.items : []).map((item) => item.label) ?? [];
    const controlAddress = (section, key, extra = {}) => ({ sidebar: "left", section, key, ...extra });
    const controlRect = (address) => s.request("dom.rect", { name: "core.sidebar.section.control", address });
    const clickControl = async (address) => {
      const rect = await controlRect(address);
      assert.ok(rect.width > 0 && rect.height > 0, `control ${JSON.stringify(address)} has no area`);
      await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    };
    const rootButtonAddress = (snapshot, section, command) => {
      const button = snapshot.value?.elements.find((element) => element.kind === "button" && element.command === command);
      assert.ok(button, `${section} has no root button for ${command}`);
      return controlAddress(section, button.key);
    };
    const treeNodeAddress = (snapshot, path, role = "label") => {
      const tree = filesTree(snapshot);
      assert.ok(tree, "files.tree has no declared tree element");
      const find = (nodes, parents = []) => {
        for (const node of nodes ?? []) {
          const keys = [...parents, node.key];
          if (node.params?.path === path) return keys;
          const nested = find(node.children, keys);
          if (nested) return nested;
        }
        return null;
      };
      const keys = find(tree.nodes);
      assert.ok(keys, `${path} is not a node of the declared tree`);
      return controlAddress("files.tree", tree.key, { path: keys, role });
    };
    const bookmarkAddress = (snapshot, path) => {
      const list = snapshot.value?.elements.find((element) => element.kind === "list");
      const item = list?.items.find((value) => value.label === path);
      assert.ok(list && item, `${path} is not an item of files.bookmarks`);
      return controlAddress("files.bookmarks", list.key, { path: [item.key], role: "label" });
    };
    const acceptedTreeSeq = async () => {
      const sidebars = await s.get("core.sidebars");
      const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
      assert.ok(Number.isInteger(section?.acceptedSeq), "the Files section has no accepted snapshot sequence");
      return section.acceptedSeq;
    };
    const treeAfterAcceptedPush = async (sequence, message) => {
      await s.until("core.sidebars", (sidebars) => {
        const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
        return Number.isInteger(section?.acceptedSeq) && section.acceptedSeq > sequence;
      }, message);
      return s.get("files.tree");
    };
    const treeAfterSelection = async (sequence, path, message) => {
      let accepted = sequence;
      // Each iteration waits for a status notification and makes one snapshot request; it does not poll or infer command completion from the click reply.
      for (;;) {
        const sidebars = await s.until("core.sidebars", (value) => {
          const section = value.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
          return Number.isInteger(section?.acceptedSeq) && section.acceptedSeq > accepted ? section.acceptedSeq : undefined;
        }, message);
        accepted = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree").acceptedSeq;
        const snapshot = await s.get("files.tree");
        if (treeNode(snapshot, path)?.selected === true) return snapshot;
      }
    };
    const waitForSectionText = (id, predicate, message) => s.until("core.sidebars",
      (sidebars) => predicate(text(sidebars, id) ?? ""), message);
    const treeAfterSectionText = async (id, predicate, message) => {
      await waitForSectionText(id, predicate, message);
      return s.get("files.tree");
    };

    // `files.refresh` completes the listing before its command reply, so read the declared snapshot once after the reply.
    assert.equal(await s.run("files.refresh"), null);
    let tree = await s.get("files.tree");
    const projectLine = tree.value.elements.find((element) => element.kind === "status-line" && element.key === "project");
    assert.equal(projectLine?.text, project.root);
    assert.ok(treeNode(tree, folder), "files.tree did not list the project folder");
    await s.until("core.sidebars", (sidebars) => {
      const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
      return section?.mounted && section.controls > 0 && section.text.includes(project.root);
    }, "the Files tree section did not render the project snapshot");
    tree = await s.get("files.tree");

    /** Clicks the label or expand control of the declared tree node by its public control address. */
    const clickRow = async (value, path) => {
      await clickControl(treeNodeAddress(value, path));
    };

    // The label selects the folder; the separate declared expand control requests an expanded snapshot through core.
    let sequence = await acceptedTreeSeq();
    let selectedTree = treeAfterSelection(sequence, folder, "the folder label did not publish its selection");
    await clickRow(tree, folder);
    tree = await selectedTree;
    sequence = await acceptedTreeSeq();
    const expandedTree = treeAfterAcceptedPush(sequence, "the folder expand control did not publish its expanded tree");
    await clickControl(treeNodeAddress(tree, folder, "expand"));
    tree = await expandedTree;
    tree = await treeAfterSectionText("files.tree", (value) => value.includes("note.txt"),
      "the folder expand control did not list its file");
    assert.ok(treeNode(tree, `${folder}/note.txt`), "the declared files.tree snapshot omitted the opened file");

    // A file created or deleted outside the application appears or disappears through the watcher without a refresh.
    writeFileSync(join(directory, "watched.txt"), "watched\n");
    tree = await treeAfterSectionText("files.tree", (value) => value.includes("watched.txt"),
      "a file created on disk did not appear without a refresh");
    assert.ok(treeNode(tree, `${folder}/watched.txt`), "the declared files.tree snapshot omitted the created file");
    rmSync(join(directory, "watched.txt"));
    tree = await treeAfterSectionText("files.tree", (value) => !value.includes("watched.txt"),
      "a file removed on disk did not leave without a refresh");
    assert.equal(treeNode(tree, `${folder}/watched.txt`), null, "the declared files.tree snapshot retained the removed file");

    // The refresh control runs files.refresh.
    await clickControl(rootButtonAddress(await s.get("files.tree"), "files.tree", "files.refresh"));

    // Bookmark: when a file is selected in the tree and the star is pressed, files.bookmarks.add runs, and it remains after it is read again.
    const note = `${folder}/note.txt`;
    tree = await s.get("files.tree");
    sequence = await acceptedTreeSeq();
    selectedTree = treeAfterSelection(sequence, note, "the file label did not publish its selection");
    await clickRow(tree, note);
    tree = await selectedTree;
    await clickControl(rootButtonAddress(await s.get("files.tree"), "files.tree", "files.bookmarks.add"));
    await waitForSectionText("files.bookmarks", (value) => value.includes(note), "the star did not bookmark the selected file");
    assert.ok(bookmarkPaths(await s.get("files.bookmarks")).includes(note), "the declared files.bookmarks snapshot omitted the file");
    s.cleanup(async () => {
      if (bookmarkPaths(await s.get("files.bookmarks")).includes(note)) await s.run("files.bookmarks.remove", { path: note });
    });
    await s.until("core.sidebars", (value) => text(value, "files.bookmarks")?.includes(note),
      "the bookmarks section did not show the bookmark");
    await s.run("core.projects.flush");
    const before = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
      "the main document did not reload");
    await s.until("core.sidebars", (value) => text(value, "files.bookmarks")?.includes(note),
      "the bookmark did not survive a reload");

    // The delete control runs files.bookmarks.remove.
    await clickControl(bookmarkAddress(await s.get("files.bookmarks"), note));
    await waitForSectionText("files.bookmarks", (value) => !value.includes(note), "a click on 삭제 did not remove the bookmark");
    assert.ok(!bookmarkPaths(await s.get("files.bookmarks")).includes(note), "the declared files.bookmarks snapshot retained the file");
  });
}

/** The first column (pt) in a one-line band of the capture that differs from the background. band is a rectangle in pt, and the background is the color of the left end of the band. */
function firstInk(image, scale, band, { from = band.x, to = band.x + band.width } = {}) {
  const background = image.pixel(Math.round(from * scale) + 1, Math.round((band.y + band.height / 2) * scale));
  for (let x = Math.round(from * scale); x < Math.round(to * scale); x++) {
    for (let y = Math.round(band.y * scale) + 2; y < Math.round((band.y + band.height) * scale) - 2; y++) {
      if (distance(image.pixel(x, y), background) > 48) return x / scale;
    }
  }
  return null;
}

/** Groups of ink columns inside the band. Columns that are gap device pixels or more apart belong to different groups. Each group is [start, end] in device pixels. */
function inkRuns(image, scale, band, gap) {
  const left = Math.round(band.x * scale);
  const background = image.pixel(left + 1, Math.round((band.y + band.height / 2) * scale));
  const runs = [];
  for (let x = left; x < Math.round((band.x + band.width) * scale); x++) {
    let ink = false;
    for (let y = Math.round(band.y * scale) + 1; y < Math.round((band.y + band.height) * scale) - 1 && !ink; y++) {
      ink = distance(image.pixel(x, y), background) > 48;
    }
    if (!ink) continue;
    const last = runs.at(-1);
    if (last && x - last[1] <= gap) last[1] = x;
    else runs.push([x, x]);
  }
  return runs;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the file tree section keeps one horizontal grid and the sidebar's 12-point rows`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const project = await s.get("core.project");
    // Periods are not used, so that the whole name is measured as one ink group. Spaces before and after a period split the group, and where it splits
    // differs by row depending on the subpixel position.
    const name = `grid-${process.pid}`;
    writeFileSync(join(project.root, name), "grid\n");
    s.cleanup(() => rmSync(join(project.root, name), { force: true }));
    await s.run("files.refresh");
    const tree = await s.until("files.tree", (value) => value?.entries.some((entry) => entry.path === name), "the tree did not list the file");
    await s.run("files.bookmarks.add", { path: name });
    s.cleanup(() => s.run("files.bookmarks.remove", { path: name }));
    const sidebars = await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === "left")
      ?.sections.find((item) => item.id === "files.bookmarks")?.text.includes(name), "the bookmark did not show");
    await s.presented();
    const { path } = await s.request("diagnostics.capture.still", {});
    s.cleanup(() => rmSync(dirname(path), { recursive: true, force: true }));
    const image = readPng(path);
    const scale = image.width / (await s.get("host.window")).content.width;

    // Section head: the head of files.tree of the left sidebar, among the heads of the list layout.
    let headerIndex = 0;
    for (const item of sidebars.filter((value) => value.layout === "list")) {
      if (item.sidebar === "left") { headerIndex += item.sections.findIndex((value) => value.id === "files.tree"); break; }
      headerIndex += item.sections.length;
    }
    const header = await s.rect("core.sidebar.section.header", headerIndex);
    const holder = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", HOLDER));
    const star = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", STAR));
    // The grid is the first column where the collapse indicator of the section head is drawn. The head text and the first display of the tree rows also start at that column.
    const chevron = firstInk(image, scale, header);
    const grid = chevron;
    const title = firstInk(image, scale, { x: holder.x, y: star.y, width: star.x - holder.x, height: star.height });
    const row = firstInk(image, scale, { x: holder.x, y: holder.y, width: holder.width / 2, height: ROW });
    const measured = { header: header.x, chevron, title, row };
    assert.ok(chevron !== null && Math.abs(chevron - header.x - 10) <= 4, `the section chevron is not near its 10-point padding: ${JSON.stringify(measured)}`);
    for (const [label, x] of Object.entries({ title, row })) {
      assert.ok(x !== null && Math.abs(x - grid) <= 1, `${label} starts at ${x}, not at the grid ${grid}: ${JSON.stringify(measured)}`);
    }
    assert.ok(holder.x <= header.x + 0.5 && holder.width >= header.width - 1, `the section body pads the tree: holder ${JSON.stringify(holder)}, header ${JSON.stringify(header)}`);

    // Text size: a bookmark row and a tree row that draw the same name with 12pt sidebar text have the same ink width. The last group of each row is the whole name.
    // In a 1x capture, gaps between 12pt glyphs are up to 3px, and the gap between the icon and the name is 8pt, so gaps of 4pt or less are joined.
    const WORD_GAP = 4;
    const at = tree.entries.findIndex((entry) => entry.path === name);
    const treeRuns = inkRuns(image, scale, { x: holder.x, y: holder.y + at * ROW, width: holder.width, height: ROW }, WORD_GAP * scale);
    const bookmarks = await s.get("files.bookmarks");
    const remove = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.bookmarks", bookmarks.indexOf(name)));
    const bookmarkRuns = inkRuns(image, scale, { x: header.x, y: remove.y, width: remove.x - header.x - 2, height: remove.height }, WORD_GAP * scale);
    // The delete button of a bookmark is apart from the path. In the whole row, it measures between the last ink column before the left boundary of the button and the first ink column from the boundary.
    // A group that crosses the boundary is split at the boundary.
    const rowRuns = inkRuns(image, scale, { x: header.x, y: remove.y, width: remove.x + remove.width - header.x, height: remove.height }, 0);
    const boundary = Math.round(remove.x * scale);
    const pathEnd = Math.max(...rowRuns.filter(([start]) => start < boundary).map(([, end]) => Math.min(end, boundary - 1)));
    const removeStart = Math.min(...rowRuns.filter(([, end]) => end >= boundary).map(([start]) => Math.max(start, boundary)));
    const separation = (removeStart - pathEnd - 1) / scale;
    assert.ok(separation >= 6, `the bookmark remove button is ${separation} pt from its path: runs ${JSON.stringify(rowRuns)}, remove ${JSON.stringify(remove)}`);
    const width = ([start, end]) => (end - start + 1) / scale;
    const treeLabel = width(treeRuns.at(-1));
    const bookmarkLabel = width(bookmarkRuns.at(-1));
    // Both ends of the name differ by up to 1 device pixel each because of anti-aliasing. The allowed width is 2 device pixels (1pt at 2x), and
    // text 1pt larger is about 6pt wider for this name, so it is distinguished.
    assert.ok(Math.abs(treeLabel - bookmarkLabel) <= 2 / scale,
      `the tree row label is ${treeLabel} pt wide and the 12-point bookmark label ${bookmarkLabel} pt (scale ${scale}): tree runs ${JSON.stringify(treeRuns)}, bookmark runs ${JSON.stringify(bookmarkRuns)}`);

    // The tree fills the height that the sidebar gave.
    const section = await s.rect("core.sidebar.section", headerIndex);
    assert.ok(holder.y + holder.height >= section.y + section.height - 1,
      `the tree ends at ${holder.y + holder.height}, before its section ends at ${section.y + section.height}`);
  });
}

/** The number of rows with ink, counted from the top of the element that holds the tree in the capture. It stops at the first empty row. */
function drawnRows(image, scale, holder) {
  let rows = 0;
  while ((rows + 1) * ROW <= holder.height) {
    const band = { x: holder.x, y: holder.y + rows * ROW, width: holder.width, height: ROW };
    if (inkRuns(image, scale, band, 1).length === 0) break;
    rows++;
  }
  return rows;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: two mounted trees of one project show files.tree and bookmark through native clicks`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await terminalCardSidebar(s);
    // Puts only the file tree in the inner left sidebar of the terminal card. Together with the tree of the left fixed sidebar, two are mounted.
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-files" ? { ...set, sections: ["files.tree"] } : set) },
      scope: "common" });
    const project = await s.get("core.project");
    const folder = `pair-${process.pid}`;
    const directory = join(project.root, folder);
    mkdirSync(directory);
    writeFileSync(join(directory, "a.txt"), "a\n");
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    await s.run("files.refresh");
    let tree = await s.until("files.tree", (value) => value?.entries.some((entry) => entry.path === folder),
      "files.tree did not list the folder");
    const mountedTrees = (value) => ["left", "terminal:left"].every((id) => value.find((item) => item.sidebar === id)
      ?.sections.find((item) => item.id === "files.tree")?.mounted);
    // The tree writes the head title and changes the rows in the callback that received the files.tree value. When the titles of both trees are visible,
    // both trees have received the value.
    const titled = (value) => mountedTrees(value) && ["left", "terminal:left"].every((id) => value.find((item) => item.sidebar === id)
      ?.sections.find((item) => item.id === "files.tree")?.text.includes(project.root.split("/").at(-1)));
    let sidebars = await s.until("core.sidebars", titled, "the left and inset trees did not receive files.tree");
    const holders = async () => {
      const value = await s.get("core.sidebars");
      return Promise.all(["left", "terminal:left"].map((id) =>
        s.rect("core.sidebar.section.control", controlIndex(value, id, "files.tree", HOLDER))));
    };
    /** The number of rows that the two trees drew. The capture is removed before the check ends. */
    const rowsDrawn = async () => {
      await s.presented();
      const window = await s.get("host.window");
      if (window.occluded) throw new Error(`${app.name}'s window is completely covered by ${coveredBy(s, window)}; nothing was measured`);
      const { path } = await s.request("diagnostics.capture.still", {});
      try {
        const image = readPng(path);
        const scale = image.width / (await s.get("host.window")).content.width;
        const header = await s.rect("core.sidebar.section.header", 0);
        if (firstInk(image, scale, header) === null) {
          throw new Error(`${app.name}'s capture shows no page (window ${JSON.stringify({ occluded: window.occluded, active: window.active, key: window.key })}); nothing was measured`);
        }
        return (await holders()).map((holder) => drawnRows(image, scale, holder));
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    };
    const same = async (what) => {
      const value = await s.get("files.tree");
      const drawn = await rowsDrawn();
      assert.deepEqual(drawn, [value.entries.length, value.entries.length],
        `${what}: the left and inset trees drew ${drawn} rows for ${value.entries.length} entries ${JSON.stringify(value.entries.map((e) => e.path))} of ${value.root} (error ${value.error})`);
      return value;
    };
    await same("after the listing");

    // When a folder is opened with a native click in the inset tree, files.tree expands it, and both trees expand together.
    const [, inset] = await holders();
    const at = tree.entries.findIndex((entry) => entry.path === folder);
    await s.click(inset.x + inset.width / 2, inset.y + (at + 0.5) * ROW);
    tree = await s.until("files.tree", (value) => value.entries.some((entry) => entry.path === `${folder}/a.txt`),
      "a click on the folder in the inset tree did not open it");
    await same("after the inset tree opened the folder");

    // A folder deleted on disk disappears from both trees together.
    rmSync(directory, { recursive: true, force: true });
    tree = await s.until("files.tree", (value) => !value.entries.some((entry) => entry.path.startsWith(folder)),
      "the removed folder stayed in files.tree");
    await same("after the folder was removed on disk");

    // Bookmark: selects a file with a native click in the inset tree and presses the star of the inset tree.
    mkdirSync(directory);
    writeFileSync(join(directory, "a.txt"), "a\n");
    await s.until("files.tree", (value) => value.entries.some((entry) => entry.path === folder), "the folder did not come back");
    sidebars = await s.get("core.sidebars");
    const [, insetNow] = await holders();
    const clickInset = async (value, path) => {
      const index = value.entries.findIndex((entry) => entry.path === path);
      assert.ok(index >= 0, `${path} is not a row`);
      await s.click(insetNow.x + insetNow.width / 2, insetNow.y + (index + 0.5) * ROW);
    };
    // Presses the inset tree while another card has the focus. The press moves the focus to the shell card and redraws the sidebar.
    await s.run("core.card.focus", { card: "browser" });
    await clickInset(await s.get("files.tree"), folder);
    const file = { path: `${folder}/a.txt` };
    await clickInset(await s.until("files.tree", (value) => value.entries.some((entry) => entry.path === file.path),
      "the inset tree did not open the folder again"), file.path);
    // The selection is state of the project, so both trees show it together, and the star of either tree bookmarks that file.
    await s.until("files.selection", (value) => value === file.path, "the selection in the inset tree did not reach files.selection");
    const star = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", STAR));
    await s.click(star.x + star.width / 2, star.y + star.height / 2);
    await s.until("files.bookmarks", (value) => value.includes(file.path),
      `a native click on ${file.path} in the inset tree and on the left tree's star did not bookmark it`);
    s.cleanup(() => s.run("files.bookmarks.remove", { path: file.path }));
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the failure to open a file is shown in the message row of the file tree and not in the error display`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // Without the editor, which opens every file, no plugin opens the files of the check. Each change of the plugin reloads the window.
    const page = async () => (await s.get("host.window")).pageProcess;
    const reloaded = async (before, message) => {
      await s.until("host.window", (value) => value.pageProcess !== 0 && value.pageProcess !== before, message);
      await s.until("host.windows", (list) => list.some((item) => item.window === s.window && item.ready), `${message}: the new page did not report ready`);
    };
    s.cleanup(async () => {
      if ((await s.get("core.plugins")).plugins.find((row) => row.id === "editor").installed.enabled) return;
      const before = await page();
      await s.run("core.plugins.enable", { plugin: "editor" });
      await reloaded(before, "enabling editor did not reload the window");
    });
    const beforeDisable = await page();
    await s.run("core.plugins.disable", { plugin: "editor" });
    await reloaded(beforeDisable, "disabling editor did not reload the window");
    const project = await s.get("core.project");
    const folder = `files-open-check-${process.pid}`;
    mkdirSync(join(project.root, folder));
    writeFileSync(join(project.root, folder, "note.zzz"), "note\n");
    writeFileSync(join(project.root, folder, "other.zzz"), "other\n");
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));
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
    tree = await s.until("files.tree", (value) => rowIndex(value, `${folder}/note.zzz`) >= 0, "a click on the folder did not open it");
    await clickRow(tree, `${folder}/note.zzz`);
    await s.until("files.selection", (value) => value === `${folder}/note.zzz`, "a click on the file did not select it");
    assert.deepEqual(await s.get("files.open"), { error: null });
    // The window check fails on every application error that is logged, so the main document showing the failure would fail it.
    await s.press("Enter");
    const failure = await s.until("files.open", (value) => value.error !== null, "Enter on a file that no plugin opens left no failure");
    assert.match(failure.error, /note\.zzz/, `the failure does not name the file: ${failure.error}`);
    const message = (await s.get("core.sidebars")).find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree")?.text;
    assert.match(message, /열 수 없음: /, `the message row does not show the failure: ${message}`);
    // Selecting another path ends the failure.
    await clickRow(tree, `${folder}/other.zzz`);
    await s.until("files.open", (value) => value.error === null, "selecting another path did not end the failure");
  });
}
