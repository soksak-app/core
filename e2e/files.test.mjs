// Files plugin check: declared UI snapshots draw the project folder and bookmarks in sidebar sections, native clicks operate the tree,
// and core sidebar notifications report rendered updates while plugin-host snapshots are pulled through status.get.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, coveredBy, open } from "@soksak/window-check/app.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";
import { hasOpenFailureRow, openFailureRow, waitTreeSnapshot } from "./files-open-failure.mjs";
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
    assert.equal(await s.run("files.refresh"), null);
    const treeElement = (snapshot) => snapshot.value?.elements.find((element) => element.kind === "tree" && element.key === "files");
    const treeNodePath = (snapshot, path) => {
      const tree = treeElement(snapshot);
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
      return keys;
    };
    const controlRect = (address) => s.request("dom.rect", { name: "core.sidebar.section.control", address });
    const treeRootRect = (snapshot) => {
      const tree = treeElement(snapshot);
      assert.ok(tree, "files.tree has no declared tree element");
      return controlRect({ sidebar: "left", section: "files.tree", key: tree.key });
    };
    const treeLabelRect = (snapshot, path) => {
      const tree = treeElement(snapshot);
      return controlRect({ sidebar: "left", section: "files.tree", key: tree.key,
        path: treeNodePath(snapshot, path), role: "label" });
    };
    const firstVisibleNodeRect = (snapshot) => {
      const tree = treeElement(snapshot);
      assert.ok(tree, "files.tree has no declared tree element");
      const node = tree.nodes?.[0];
      assert.ok(node, "files.tree has no first visible node");
      const role = node.branch ? "expand" : node.command || node.open ? "label" : null;
      assert.ok(role, "the first visible node has no declared geometry control");
      return controlRect({ sidebar: "left", section: "files.tree", key: tree.key,
        path: [node.key], role });
    };
    let tree = await s.get("files.tree");
    assert.ok(treeNodePath(tree, name), "the tree snapshot did not list the file");
    const sidebars = await s.until("core.sidebars", (value) => {
      const section = value.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
      return section?.mounted && section.text.includes(name);
    }, "the Files tree section did not render the file snapshot");
    tree = await s.get("files.tree");
    await s.run("files.bookmarks.add", { path: name });
    s.cleanup(() => s.run("files.bookmarks.remove", { path: name }));
    await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === "left")
      ?.sections.find((item) => item.id === "files.bookmarks")?.text.includes(name), "the bookmark did not show");
    const bookmarks = await s.get("files.bookmarks");
    const bookmarkList = bookmarks.value?.elements.find((element) => element.kind === "list");
    const bookmark = bookmarkList?.items.find((item) => item.label === name);
    assert.ok(bookmarkList && bookmark, "files.bookmarks did not publish the file");
    assert.equal(bookmark.command, "files.bookmarks.remove", "the bookmark label is not the declared remove control");
    const removeRect = await controlRect({ sidebar: "left", section: "files.bookmarks", key: bookmarkList.key,
      path: [bookmark.key], role: "label" });
    await s.presented();
    const { path } = await s.request("diagnostics.capture.still", {});
    const image = readPng(path);
    const scale = image.width / (await s.get("host.window")).content.width;

    // Section head: the head of files.tree of the left sidebar, among the heads of the list layout.
    let headerIndex = 0;
    for (const item of sidebars.filter((value) => value.layout === "list")) {
      if (item.sidebar === "left") { headerIndex += item.sections.findIndex((value) => value.id === "files.tree"); break; }
      headerIndex += item.sections.length;
    }
    const header = await s.rect("core.sidebar.section.header", headerIndex);
    const holder = await treeRootRect(tree);
    const rowBox = await treeLabelRect(tree, name);
    const projectLine = tree.value.elements.find((element) => element.kind === "status-line" && element.key === "project");
    assert.ok(projectLine, "files.tree has no project status line");
    const titleRect = await s.request("dom.rect", { name: "core.sidebar.section.status-line",
      address: { sidebar: "left", section: "files.tree", key: projectLine.key } });
    const firstNode = await firstVisibleNodeRect(tree);
    // The grid is the first column where the collapse indicator of the section head is drawn. The head text and the first display of the tree rows also start at that column.
    const chevron = firstInk(image, scale, header);
    const grid = chevron;
    const title = firstInk(image, scale, titleRect);
    const row = firstInk(image, scale, firstNode);
    const measured = { header, chevron, titleBox: titleRect, title, holder, firstNode, row };
    assert.ok(chevron !== null && Math.abs(chevron - header.x - 10) <= 4, `the section chevron is not near its 10-point padding: ${JSON.stringify(measured)}`);
    for (const [label, x] of Object.entries({ title, row })) {
      assert.ok(x !== null && Math.abs(x - grid) <= 1, `${label} starts at ${x}, not at the grid ${grid}: ${JSON.stringify(measured)}`);
    }
    assert.ok(holder.x <= header.x + 0.5 && holder.width >= header.width - 1, `the section body pads the tree: holder ${JSON.stringify(holder)}, header ${JSON.stringify(header)}`);

    // Text size: a bookmark row and the fixture file row that draw the same name with 12pt sidebar text have the same ink width. The last group of each row is the whole name.
    // In a 1x capture, gaps between 12pt glyphs are up to 3px, and the gap between the icon and the name is 8pt, so gaps of 4pt or less are joined.
    const WORD_GAP = 4;
    const treeRuns = inkRuns(image, scale, { x: holder.x, y: rowBox.y, width: holder.width, height: ROW }, WORD_GAP * scale);
    const bookmarkRuns = inkRuns(image, scale,
      { x: header.x, y: removeRect.y, width: removeRect.x - header.x - 2, height: removeRect.height }, WORD_GAP * scale);
    // The delete button of a bookmark is apart from the path. In the whole row, it measures between the last ink column before the left boundary of the button and the first ink column from the boundary.
    // A group that crosses the boundary is split at the boundary.
    const rowRuns = inkRuns(image, scale,
      { x: header.x, y: removeRect.y, width: removeRect.x + removeRect.width - header.x, height: removeRect.height }, 0);
    const boundary = Math.round(removeRect.x * scale);
    const pathEnd = Math.max(...rowRuns.filter(([start]) => start < boundary).map(([, end]) => Math.min(end, boundary - 1)));
    const removeStart = Math.min(...rowRuns.filter(([, end]) => end >= boundary).map(([start]) => Math.max(start, boundary)));
    const separation = (removeStart - pathEnd - 1) / scale;
    assert.ok(separation >= 6, `the bookmark remove control is ${separation} pt from its path: runs ${JSON.stringify(rowRuns)}, control ${JSON.stringify(removeRect)}`);
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
    rmSync(dirname(path), { recursive: true, force: true });
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: two mounted trees of one project show files.tree and bookmark through native clicks`,
    { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const project = await s.until("core.project", (value) => value?.root, "the fixture project was not shown");
    await terminalCardSidebar(s, { sections: ["files.tree"] });
    const folder = `pair-${process.pid}`;
    const directory = join(project.root, folder);
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    const treeSidebars = ["left", "terminal:left"];
    const sectionOf = (sidebars, sidebar, section) => sidebars.find((item) => item.sidebar === sidebar)
      ?.sections.find((item) => item.id === section);
    const treeElement = (snapshot) => snapshot.value?.elements.find((element) => element.kind === "tree" && element.key === "files");
    const treeNodePath = (snapshot, path) => {
      const tree = treeElement(snapshot);
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
      assert.ok(keys, `${path} is not a node of files.tree`);
      return keys;
    };
    const treeNode = (snapshot, path) => {
      const find = (nodes) => {
        for (const node of nodes ?? []) {
          if (node.params?.path === path) return node;
          const nested = find(node.children);
          if (nested) return nested;
        }
        return null;
      };
      return find(treeElement(snapshot)?.nodes);
    };
    const visibleNodes = (snapshot) => {
      const rows = [];
      const visit = (nodes, parents = []) => {
        for (const node of nodes ?? []) {
          const path = [...parents, node.key];
          rows.push({ node, path });
          if (node.expanded === true) visit(node.children, path);
        }
      };
      visit(treeElement(snapshot)?.nodes);
      return rows;
    };
    const cursorOf = (sidebars, sidebar, status) => {
      const section = sectionOf(sidebars, sidebar, status);
      return { source: JSON.stringify(section?.source ?? null), seq: section?.acceptedSeq ?? null };
    };
    const cursorsOf = (sidebars, status) => Object.fromEntries(treeSidebars.map((sidebar) =>
      [sidebar, cursorOf(sidebars, sidebar, status)]));
    const sectionAdvanced = (sidebars, sidebar, status, cursor) => {
      const section = sectionOf(sidebars, sidebar, status);
      if (!section?.mounted || !Number.isInteger(section.acceptedSeq)) return false;
      const source = JSON.stringify(section.source ?? null);
      return source !== cursor.source || cursor.seq === null || section.acceptedSeq > cursor.seq;
    };
    const waitAcceptedSnapshot = async (status, before, accepts, message) => {
      let cursor = before;
      for (;;) {
        const sidebars = await s.until("core.sidebars", (value) => treeSidebars.every((sidebar) =>
          sectionAdvanced(value, sidebar, status, cursor[sidebar])), message);
        const snapshot = await s.get(status);
        assert.ok(Number.isInteger(snapshot.version), `${status} has no snapshot version`);
        const allAccepted = treeSidebars.every((sidebar) =>
          sectionOf(sidebars, sidebar, status)?.acceptedSeq >= snapshot.version);
        if (allAccepted && accepts(snapshot, sidebars)) return { snapshot, sidebars, cursor: cursorsOf(sidebars, status) };
        cursor = cursorsOf(sidebars, status);
      }
    };
    const controlRect = (address) => s.request("dom.rect", { name: "core.sidebar.section.control", address });
    const clickControl = async (address) => {
      const rect = await controlRect(address);
      assert.ok(rect.width > 0 && rect.height > 0, `control ${JSON.stringify(address)} has no area`);
      await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    };
    const rootAddress = (sidebar, snapshot, command) => {
      const button = snapshot.value?.elements.find((element) => element.kind === "button" && element.command === command);
      assert.ok(treeElement(snapshot) && button, `files.tree has no root button for ${command}`);
      return { sidebar, section: "files.tree", key: button.key };
    };
    const nodeAddress = (sidebar, snapshot, path, role = "label") => {
      const tree = treeElement(snapshot);
      assert.ok(tree, "files.tree has no declared tree element");
      return { sidebar, section: "files.tree", key: tree.key, path: treeNodePath(snapshot, path), role };
    };
    const treeRects = async (snapshot) => {
      const tree = treeElement(snapshot);
      assert.ok(tree, "files.tree has no declared tree element");
      const rows = visibleNodes(snapshot);
      assert.ok(rows.length > 0, "files.tree has no visible declared rows");
      return Promise.all(treeSidebars.map(async (sidebar) => {
        const holder = await controlRect({ sidebar, section: "files.tree", key: tree.key });
        const controls = await Promise.all(rows.map(({ node, path }) => {
          const role = node.branch === true || node.children?.length > 0 ? "expand" : "label";
          return controlRect({ sidebar, section: "files.tree", key: tree.key, path, role });
        }));
        return { holder, controls };
      }));
    };
    const waitTree = async (before, predicate, message) => waitAcceptedSnapshot("files.tree", before,
      (snapshot, sidebars) => predicate(snapshot) && treeSidebars.every((sidebar) => {
        const section = sectionOf(sidebars, sidebar, "files.tree");
        return section?.mounted && section.text.includes(project.root.split("/").at(-1));
      }), message);
    /** The number of rows that the two trees drew. The capture is removed before the check ends. */
    const rowsDrawn = async (snapshot) => {
      await s.presented();
      const window = await s.get("host.window");
      if (window.occluded) throw new Error(`${app.name}'s window is completely covered by ${coveredBy(s, window)}; nothing was measured`);
      const { path } = await s.request("diagnostics.capture.still", {});
      let passed = false;
      try {
        const image = readPng(path);
        const scale = image.width / (await s.get("host.window")).content.width;
        const currentSidebars = await s.get("core.sidebars");
        let headerIndex = 0;
        for (const sidebar of currentSidebars.filter((value) => value.layout === "list")) {
          const at = sidebar.sections.findIndex((section) => section.id === "files.tree");
          if (sidebar.sidebar === "left") {
            assert.ok(at >= 0, "the left sidebar has no Files tree section header");
            headerIndex += at;
            break;
          }
          headerIndex += sidebar.sections.length;
        }
        const header = await s.rect("core.sidebar.section.header", headerIndex);
        if (firstInk(image, scale, header) === null) {
          throw new Error(`${app.name}'s capture shows no page (window ${JSON.stringify({ occluded: window.occluded, active: window.active, key: window.key })}); nothing was measured`);
        }
        const nodes = visibleNodes(snapshot);
        const trees = await treeRects(snapshot);
        const drawn = trees.map(({ holder, controls }) => controls.filter((rect) =>
          inkRuns(image, scale, { x: holder.x, y: rect.y, width: holder.width, height: rect.height }, 1).length > 0).length);
        const details = JSON.stringify({ nodes: nodes.map(({ node }) => ({ key: node.key, path: node.params?.path,
          expanded: node.expanded === true })), trees: trees.map(({ holder, controls }) => ({ holder, controls })), drawn });
        try {
          assert.deepEqual(drawn, [nodes.length, nodes.length],
            `${app.name}: the left and inset trees drew ${drawn} rows for ${nodes.length} visible declared nodes`);
        } catch (error) {
          throw new Error(`${error.message}; measurements ${details}; capture retained at ${path}`, { cause: error });
        }
        passed = true;
        return drawn;
      } catch (error) {
        if (error.message.includes("capture retained at")) throw error;
        throw new Error(`${error.message}; capture retained at ${path}`, { cause: error });
      } finally {
        if (passed) rmSync(dirname(path), { recursive: true, force: true });
      }
    };
    const same = async (what, value) => {
      const drawn = await rowsDrawn(value);
      assert.equal(drawn[0], drawn[1], `${what}: the two rendered trees drew different row counts ${drawn}`);
      return value;
    };

    let sidebars = await s.get("core.sidebars");
    let cursor = cursorsOf(sidebars, "files.tree");
    mkdirSync(directory);
    writeFileSync(join(directory, "a.txt"), "a\n");
    assert.equal(await s.run("files.refresh"), null);
    let state = await waitTree(cursor, (snapshot) => treeNode(snapshot, folder) !== null,
      "files.tree did not list the folder in both mounted trees");
    let tree = await same("after the listing", state.snapshot);

    // A native click on the inset branch expands the same snapshot in both mounted trees.
    cursor = state.cursor;
    await clickControl(nodeAddress("terminal:left", tree, folder, "expand"));
    state = await waitTree(cursor, (snapshot) => treeNode(snapshot, folder)?.expanded === true
      && treeNode(snapshot, `${folder}/a.txt`) !== null,
    "a native click on the inset tree branch did not expand it in both trees");
    tree = await same("after the inset tree opened the folder", state.snapshot);

    // A folder deleted on disk disappears from both trees together.
    cursor = state.cursor;
    rmSync(directory, { recursive: true, force: true });
    state = await waitTree(cursor, (snapshot) => treeNode(snapshot, folder) === null,
      "the removed folder stayed in both rendered trees");
    tree = await same("after the folder was removed on disk", state.snapshot);

    // Bookmark: select with a native click in the inset tree and press the left tree's declared bookmark command.
    cursor = state.cursor;
    mkdirSync(directory);
    writeFileSync(join(directory, "a.txt"), "a\n");
    assert.equal(await s.run("files.refresh"), null);
    state = await waitTree(cursor, (snapshot) => treeNode(snapshot, folder) !== null,
      "the refreshed tree did not list the folder again");
    tree = state.snapshot;
    cursor = state.cursor;
    await clickControl(nodeAddress("terminal:left", tree, folder, "expand"));
    state = await waitTree(cursor, (snapshot) => treeNode(snapshot, `${folder}/a.txt`) !== null,
      "the inset tree did not show the file after expansion");
    tree = await same("after the inset tree opened the folder again", state.snapshot);

    // Select the file with the inset tree while another card has the focus.
    await s.run("core.card.focus", { card: "browser" });
    await s.until("core.grid", (grid) => grid.cards.find((card) => card.id === "browser")?.focused,
      "core.card.focus did not focus the browser card");
    const file = `${folder}/a.txt`;
    sidebars = await s.get("core.sidebars");
    cursor = cursorsOf(sidebars, "files.tree");
    await clickControl(nodeAddress("terminal:left", tree, file));
    state = await waitTree(cursor, (snapshot) => treeNode(snapshot, file)?.selected === true,
      "the native inset-tree selection was not accepted by both trees");
    tree = await same("after the inset tree selected the file", state.snapshot);

    // Add bookmark sections only after the fixture project is active, and wait for both sections to accept the snapshot.
    sidebars = await s.get("core.sidebars");
    cursor = Object.fromEntries(treeSidebars.map((sidebar) => {
      const section = sectionOf(sidebars, sidebar, "files.bookmarks");
      return [sidebar, { source: JSON.stringify(section?.source ?? null), seq: null }];
    }));
    const settings = (await s.get("core.settings")).values;
    await s.run("core.settings.set", { patch: { sets: settings.sets.map((set) => set.id === "set-files"
      ? { ...set, sections: ["files.tree", "files.bookmarks"] } : set) }, scope: "common" });
    const bookmarkState = await waitAcceptedSnapshot("files.bookmarks", cursor, () => true,
      "both bookmark sections did not accept the initial snapshot");
    sidebars = bookmarkState.sidebars;
    cursor = bookmarkState.cursor;
    s.cleanup(() => s.run("files.bookmarks.remove", { path: file }));
    await clickControl(rootAddress("left", tree, "files.bookmarks.add"));
    const bookmarked = await waitAcceptedSnapshot("files.bookmarks", cursor,
      (snapshot) => snapshot.value?.elements.some((element) => element.kind === "list"
        && element.items.some((item) => item.label === file)),
      `a native click on ${file} in the inset tree and the left tree's star did not bookmark it`);
    assert.ok(treeSidebars.every((sidebar) => sectionOf(bookmarked.sidebars, sidebar, "files.bookmarks")?.text.includes(file)),
      "both bookmark sections did not display the selected file");
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
    const nodeByPath = (snapshot, path) => treeNodes(snapshot).find((node) => node.params?.path === path) ?? null;
    const nodeKeyPath = (snapshot, path) => {
      const tree = snapshot.value?.elements.find((element) => element.kind === "tree" && element.key === "files");
      const find = (nodes, parents = []) => {
        for (const node of nodes ?? []) {
          const keys = [...parents, node.key];
          if (node.params?.path === path) return keys;
          const nested = find(node.children, keys);
          if (nested) return nested;
        }
        return null;
      };
      const keys = find(tree?.nodes);
      assert.ok(keys, `${path} is not a node of the declared files.tree snapshot`);
      return keys;
    };
    const clickRow = async (snapshot, path, role = "label") => {
      const address = { sidebar: "left", section: "files.tree", key: "files", path: nodeKeyPath(snapshot, path), role };
      const rect = await s.request("dom.rect", { name: "core.sidebar.section.control", address });
      assert.ok(rect.width > 0 && rect.height > 0, `${path} ${role} control has no area`);
      await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    };
    const acceptedTreeSequence = async () => {
      const section = (await s.get("core.sidebars")).find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
      assert.ok(Number.isInteger(section?.acceptedSeq), "the Files tree has no accepted snapshot sequence");
      return section.acceptedSeq;
    };
    let accepted = await acceptedTreeSequence();
    assert.equal(await s.run("files.refresh"), null);
    let current = await waitTreeSnapshot(s, accepted,
      (snapshot) => nodeByPath(snapshot, folder) !== null,
      "files.tree did not list the folder");
    let tree = current.snapshot;
    accepted = current.sequence;
    await clickRow(tree, folder);
    current = await waitTreeSnapshot(s, accepted,
      (snapshot) => nodeByPath(snapshot, folder)?.selected === true,
      "a click on the folder did not select it");
    tree = current.snapshot;
    accepted = current.sequence;
    await clickRow(tree, folder, "expand");
    current = await waitTreeSnapshot(s, accepted,
      (snapshot) => nodeByPath(snapshot, `${folder}/note.zzz`) !== null,
      "the folder expand control did not list its file");
    tree = current.snapshot;
    accepted = current.sequence;
    await clickRow(tree, `${folder}/note.zzz`);
    current = await waitTreeSnapshot(s, accepted,
      (snapshot) => nodeByPath(snapshot, `${folder}/note.zzz`)?.selected === true,
      "a click on the file did not select it");
    accepted = current.sequence;
    // The window check fails on every application error that is logged, so the main document showing the failure would fail it.
    const failed = await openFailureRow(s, `${folder}/note.zzz`, accepted, () => s.press("Enter"));
    // Selecting another path ends the failure.
    await clickRow(failed.snapshot, `${folder}/other.zzz`);
    await waitTreeSnapshot(s, failed.sequence,
      (snapshot, section) => !hasOpenFailureRow(snapshot) && !section.text.includes("열 수 없음: ") &&
        nodeByPath(snapshot, `${folder}/other.zzz`)?.selected === true,
      "selecting another path did not end the failure");
  });
}
