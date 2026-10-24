// Editor check: a file opens from the declared Files tree in the plugin whose surface.opens declares its extension, native keys
// edit it and Command-S saves it, a failed save shows the tab error until a save succeeds, the tab keeps its params
// after the page reloads, and closing a modified tab asks before it closes (docs/spec/plugins.md#tab-reports).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

const filesTree = (snapshot) => snapshot.value?.elements.find((element) => element.key === "files" && element.kind === "tree");

/** Waits until the view has registered the status before the first status watch. */
const editorDocumentRegistered = (s, surface) => s.until("core.surfaces", (all) => {
  const view = all.find((item) => item.surface === surface);
  return view?.exposes.includes("status editor.document") ? view : undefined;
}, "the editor did not register status editor.document");

const treeNode = (snapshot, path) => filesTree(snapshot)?.nodes?.flatMap(function flatten(node) {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}).find((node) => node.params?.path === path) ?? null;

/** Returns the public control address for a node's label or expand control. */
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
  assert.ok(keys, `${path} is not a node of files.tree`);
  return { sidebar: "left", section: "files.tree", key: tree.key, path: keys, role };
};

/** Clicks an interactive tree control using its declared DOM address. */
const clickTreeControl = async (s, address) => {
  const rect = await s.request("dom.rect", { name: "core.sidebar.section.control", address });
  assert.ok(rect.width > 0 && rect.height > 0, `control ${JSON.stringify(address)} has no area`);
  await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
};

/** Gives an inactive editor view the native first responder through its declared text element. */
const focusEditorForKeys = async (s, surface) => {
  const content = await s.request("dom.rect", { name: "editor.content", surface });
  assert.ok(content.width > 0 && content.height > 0, "editor.content has no area");
  await s.click(content.x + content.width / 2, content.y + content.height / 2);
  await s.until("host.window", (window) => window.responder?.surface === surface,
    "the editor view did not take native focus after a press on editor.content");
};

/** Focuses the public control whose rectangle resolves from its address, without assuming its DOM order. */
const focusTreeControl = async (s, address) => {
  const name = "core.sidebar.section.control";
  const target = await s.request("dom.rect", { name, address });
  const sidebars = await s.get("core.sidebars");
  const count = sidebars.flatMap((sidebar) => sidebar.sections).reduce((sum, section) => sum + section.controls, 0);
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const rect = await s.rect(name, index);
    if (["x", "y", "width", "height"].every((key) => rect[key] === target[key])) matches.push(index);
  }
  assert.equal(matches.length, 1, `control ${JSON.stringify(address)} maps to ${matches.length} DOM indexes`);
  const [index] = matches;
  await s.run("core.focus.set", { name, index });
  await s.until("core.focus", (focus) => focus?.name === name && focus.index === index && focus.surface === null,
    `core.focus.set did not focus control ${JSON.stringify(address)}`);
};

/** Waits for a newer rendered Files snapshot that records a node selection. */
const treeAfterSelection = async (s, sequence, path, message) => {
  let accepted = sequence;
  for (;;) {
    const sidebars = await s.until("core.sidebars", (value) => {
      const section = value.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
      return Number.isInteger(section?.acceptedSeq) && section.acceptedSeq > accepted ? section.acceptedSeq : undefined;
    }, message);
    accepted = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree").acceptedSeq;
    const snapshot = await s.get("files.tree");
    const node = treeNode(snapshot, path);
    if (node?.selected === true) return snapshot;
  }
};

const acceptedTreeSequence = async (s) => {
  const sidebars = await s.get("core.sidebars");
  const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
  assert.ok(Number.isInteger(section?.acceptedSeq), "the Files section has no accepted snapshot sequence");
  return section.acceptedSeq;
};

/** Waits for a newer rendered Files snapshot after an expand-control request. */
const treeAfterAcceptedPush = async (s, sequence, message) => {
  await s.until("core.sidebars", (sidebars) => {
    const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
    return Number.isInteger(section?.acceptedSeq) && section.acceptedSeq > sequence;
  }, message);
  return s.get("files.tree");
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: a file opens from the tree in the editor, saves, shows a save error and asks before it closes`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { lifecycle: "info", input: "info" }, reads: [
      "native.record.info", "native.window.first_responder", "native.app.activated", "native.app.deactivated",
      "native.window.key", "native.window.resign_key",
    ] });
    const project = await s.get("core.project");
    const folder = `editor-check-${process.pid}`;
    const path = `${folder}/note.txt`;
    const file = join(project.root, path);
    mkdirSync(join(project.root, folder));
    writeFileSync(file, "alpha\r\nbeta\r\n");
    s.cleanup(() => rmSync(join(project.root, folder), { recursive: true, force: true }));

    // The declared snapshot and DOM addresses identify each tree control; no row geometry or plugin-private DOM is assumed.
    await s.run("files.refresh");
    let tree = await s.get("files.tree");
    assert.ok(treeNode(tree, folder), "files.tree did not list the folder");
    await s.until("core.sidebars", (sidebars) => {
      const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
      return section?.mounted && section.controls > 0;
    }, "the Files tree section did not render its snapshot");

    let sequence = await acceptedTreeSequence(s);
    const folderSelection = treeAfterSelection(s, sequence, folder, "the folder label did not publish its selection");
    await clickTreeControl(s, treeNodeAddress(tree, folder));
    tree = await folderSelection;
    sequence = await acceptedTreeSequence(s);
    const expandedTree = treeAfterAcceptedPush(s, sequence, "the folder expand control did not publish its tree");
    await clickTreeControl(s, treeNodeAddress(tree, folder, "expand"));
    tree = await expandedTree;
    assert.ok(treeNode(tree, folder)?.children?.some((child) => child.params?.path === path),
      "files.tree did not list the file under the expanded folder");

    sequence = await acceptedTreeSequence(s);
    const fileSelection = treeAfterSelection(s, sequence, path, "the file label did not publish its selection");
    await clickTreeControl(s, treeNodeAddress(tree, path));
    tree = await fileSelection;
    const selectedNode = treeNode(tree, path);
    assert.equal(selectedNode?.selected, true, "the file tree did not mark the file selection");
    await focusTreeControl(s, treeNodeAddress(tree, path));
    await s.press("Enter");
    // The editor reports ready after it read the file; a surface error ends the wait with its text.
    const editor = await s.until("core.surfaces", (all) => all.some((x) => x.visible && x.plugin === "editor"
      && x.status.phase !== "loading"), "Enter on the selected file opened no editor tab");
    const opened = editor.find((x) => x.visible && x.plugin === "editor");
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
    assert.equal(opened.status.phase, "ready", `the editor surface failed: ${opened.status.error}`);
    await editorDocumentRegistered(s, surface);
    const label = (await s.get("core.grid")).cards.flatMap((card) => card.tabs ?? []).find((tab) => tab.id === surface)?.label;
    assert.equal(label, "note.txt", "the editor tab is not named after its file");
    let document = await s.until("editor.document", (value) => value.path === path && value.version !== null,
      "the editor did not read the file", { surface });
    assert.equal(document.newline, "crlf");
    assert.equal(document.modified, false);
    const tabOf = async () => (await s.get("core.grid")).cards.flatMap((card) => card.tabs ?? []).find((tab) => tab.id === surface);

    // Native keys edit the text, the tab shows modified, and Command-S writes the file with its line breaks.
    const inputOffsets = currentEventOffsets(s.app.configDir);
    // An inactive window sends keys to its native first responder. Press the declared editor element so its view becomes that responder.
    await focusEditorForKeys(s, surface);
    await s.run("editor.select", { anchor: 0 }, surface);
    await s.run("editor.focus", {}, surface);
    // A view surface has its own native webview; core.focus observes the workbench page, not this document.
    const pageFocusAfterCommand = await s.get("core.focus");
    const windowAfterCommand = await s.get("host.window");
    await s.press("x", { text: "x" });
    const pageFocusAfterInput = await s.get("core.focus");
    const windowAfterInput = await s.get("host.window");
    try {
      await s.until("editor.document", (value) => value.modified, "a native key did not modify the text", { surface });
    } catch (error) {
      await s.flushLog();
      const events = readEvents(s.app.configDir, inputOffsets).events;
      const nativeInput = events.filter((event) => event.event === "native.record.info" && event.fields.where === "input inject")
        .map((event) => {
          try { return JSON.parse(event.fields.text); }
          catch { return event.fields.text; }
        });
      const responderChanges = events.filter((event) => event.event === "native.window.first_responder" || event.event === "native.window.key"
        || event.event === "native.window.resign_key" || event.event === "native.app.activated" || event.event === "native.app.deactivated")
        .map((event) => ({ event: event.event, fields: event.fields }));
      error.message += `; main-page focus after editor.focus ${JSON.stringify(pageFocusAfterCommand)}; `
        + `host.window after editor.focus ${JSON.stringify({ key: windowAfterCommand.key, active: windowAfterCommand.active,
          responder: windowAfterCommand.responder, webviews: windowAfterCommand.webviews })}; `
        + `main-page focus after input ${JSON.stringify(pageFocusAfterInput)}; `
        + `host.window after input ${JSON.stringify({ key: windowAfterInput.key, active: windowAfterInput.active,
          responder: windowAfterInput.responder, webviews: windowAfterInput.webviews })}; `
        + `native input ${JSON.stringify(nativeInput)}; responder/activity events ${JSON.stringify(responderChanges)}`;
      throw error;
    }
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
    await editorDocumentRegistered(s, surface);
    await s.until("editor.document", (value) => value.path === path && value.version !== null,
      "the editor tab did not read its file after the reload", { surface });

    // Closing a modified tab asks; the keep-open choice keeps it, and the discard choice closes it without writing.
    await focusEditorForKeys(s, surface);
    await s.run("editor.select", { anchor: 0 }, surface);
    await s.run("editor.focus", {}, surface);
    await s.press("z", { text: "z" });
    document = await s.until("editor.document", (value) => value.modified, "a native key did not modify the text before close", { surface });
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
