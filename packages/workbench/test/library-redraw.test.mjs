// 라이브러리를 다시 그려도 바뀌지 않은 카드의 조작 요소는 문서에 남는다(docs/spec/exposure.md). 누름과 뗌 사이에
// 눌린 요소가 문서에서 빠지면 WebKit 은 click 을 보내지 않는다(F66.1).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("a library render keeps the controls of unchanged project cards in the document", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;
  const projects = [
    { id: "prj-a", title: "a", root: "/work/a", spaces: [{ id: "s" }], activeSpaceId: "s" },
    { id: "prj-b", title: "b", root: "/work/b", spaces: [{ id: "s" }], activeSpaceId: "s" },
  ];
  t.mock.module("../projects.js", { namedExports: {
    inLibrary: () => true, all: () => projects, isOpen: () => false, active: () => null, close: async () => {},
  } });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  t.mock.module("@soksak/runtime", { namedExports: { host: null, windows: { createsFolders: false,
    folder: async (root) => ({ root, identity: "id" }) } } });
  t.mock.module("../library-preview.js", { namedExports: { preview: () => {
    const el = document.createElement("div"); el.className = "library-preview"; return el;
  } } });
  t.mock.module("../commands.js", { namedExports: { delegate: () => {}, mark: (element, command, params) => {
    element.dataset.command = command; element.dataset.params = JSON.stringify(params);
  } } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: { hosted: false, status: () => ({ plugins: [], operation: null }), failure: () => null, refresh: async () => {} },
    onPluginOperations: () => {},
  } });
  const { createLibrary } = await import("../library.js?redraw");
  const library = createLibrary(document.getElementById("library"));
  library.render();
  await new Promise((resolve) => setImmediate(resolve));
  const controls = [...document.querySelectorAll(".library-project button")];
  assert.ok(controls.length >= 2, "the library drew no card controls");
  const removed = [];
  const watch = new dom.window.MutationObserver((records) => {
    for (const record of records) for (const node of record.removedNodes) {
      if (node.nodeType === 1 && (node.matches?.("button") || node.querySelector?.("button"))) removed.push(node.className);
    }
  });
  watch.observe(document.body, { childList: true, subtree: true });
  library.render();
  await new Promise((resolve) => setImmediate(resolve));
  for (const record of watch.takeRecords()) for (const node of record.removedNodes) {
    if (node.nodeType === 1 && (node.matches?.("button") || node.querySelector?.("button"))) removed.push(node.className);
  }
  watch.disconnect();
  assert.deepEqual(removed, [], "a render of unchanged projects took card controls out of the document");
  assert.ok(controls.every((control) => control.isConnected), "a card control of the first render is no longer in the document");
  dom.window.close();
});

test("a plugin page render keeps the controls of unchanged plugin cards in the document", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  t.mock.module("../projects.js", { namedExports: {
    inLibrary: () => true, all: () => [], isOpen: () => false, active: () => null, close: async () => {},
  } });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  t.mock.module("@soksak/runtime", { namedExports: { host: null, windows: { createsFolders: false, folder: async (root) => ({ root }) } } });
  t.mock.module("../library-preview.js", { namedExports: { preview: () => document.createElement("div") } });
  t.mock.module("../commands.js", { namedExports: { delegate: () => {}, mark: (element, command, params) => {
    element.dataset.command = command; element.dataset.params = JSON.stringify(params ?? {});
  } } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  const status = { registry: "file:///registry/index.json", error: null, restart: false, operation: null, plugins: [
    { id: "term", name: "터미널", description: "", state: "loaded", installed: { version: "0.1.0", enabled: true }, latest: "0.1.0", sidecars: [] },
  ] };
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: { hosted: true, status: () => status, failure: () => null, refresh: async () => {} },
    onPluginOperations: () => {},
  } });
  const { createLibrary } = await import("../library.js?redraw-plugins");
  const library = createLibrary(document.getElementById("library"));
  await library.actions.page("plugins");
  library.render();
  const buttons = [...document.querySelectorAll('[data-expose="core.library.plugins.action"]')];
  assert.ok(buttons.length > 0, "the plugin page drew no action controls");
  library.render();
  assert.ok(buttons.every((button) => button.isConnected), "a render of unchanged plugins took action controls out of the document");
  dom.window.close();
});
