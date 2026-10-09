import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// The core update is the first row of the update list of the plugin page (docs/spec/installation.md#application-update).
test("the update list shows the core update first with its release link, its action and the steps of the operation", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  t.mock.module("../projects.js", { namedExports: {
    inLibrary: () => true, all: () => [], isOpen: () => false, active: () => null,
  } });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  t.mock.module("@soksak/runtime", { namedExports: { host: null, windows: { createsFolders: false, folder: async (root) => ({ root }) } } });
  t.mock.module("../library-preview.js", { namedExports: { preview: () => document.createElement("div") } });
  t.mock.module("../commands.js", { namedExports: { delegate: () => {}, mark: (element, command, params, value) => {
    element.dataset.command = command;
    element.dataset.params = JSON.stringify(params ?? {});
    if (value) element.dataset.value = value;
  } } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  let app = {
    version: "0.0.8",
    available: { version: "0.0.9", release: "https://github.com/soksak-app/core/releases/tag/v0.0.9" },
    operation: null, error: null,
    incompatible: [
      { id: "term", installed: "0.2.0", range: "^0.0.8", compatible: "0.3.0" },
      { id: "notes", installed: "1.0.0", range: "^0.0.8", compatible: null },
    ],
  };
  const status = { registry: "file:///registry/index.json", error: null, reload: false, outdated: [], plugins: [],
    updates: [{ id: "term", installed: "0.1.0", latest: "0.2.0" }], operation: null };
  const operations = { hosted: true, status: () => status, failure: () => null, refresh: async () => {}, refreshOutdated: async () => {} };
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: operations, onPluginOperations: () => {}, appUpdate: { status: () => app, refresh: async () => {} },
  } });
  const { createLibrary } = await import("../library.js?app-update");
  const root = document.getElementById("library");
  const library = createLibrary(root);
  try {
    library.actions.page("plugins");
    const row = () => root.querySelector('[data-expose="core.library.app.row"]');
    const list = root.querySelector(".library-updates");
    assert.equal(list.firstElementChild, row(), "the core update is not the first row of the update list");
    assert.equal(row().querySelector("p").textContent, "core: 0.0.8 → 0.0.9");
    const buttons = [...row().querySelectorAll("button")].map((b) => [b.textContent, b.dataset.expose, b.dataset.command]);
    assert.deepEqual(buttons, [
      ["릴리스 페이지", "core.library.app.release", "core.app.release"],
      ["업데이트", "core.library.app.update", "core.app.update"],
    ]);
    assert.equal(root.querySelector('[data-expose="core.library.app.operation"]'), null);
    // A plugin that the candidate does not contain is listed under the row with its newest version that does.
    const incompatible = [...row().querySelectorAll('[data-expose="core.library.app.incompatible"]')].map((item) => item.textContent);
    assert.deepEqual(incompatible, [
      "term 0.2.0 (^0.0.8): 0.0.9에 맞는 최신 버전 0.3.0",
      "notes 1.0.0 (^0.0.8): 0.0.9에 맞는 버전 없음",
    ]);

    // The steps of the operation and its error are shown on the row.
    app = { ...app, operation: { state: "staging", version: "0.0.9", error: null } };
    library.render();
    assert.equal(root.querySelector('[data-expose="core.library.app.operation"]').textContent, "0.0.9 받는 중");
    app = { ...app, operation: { state: "applying", version: "0.0.9", error: null } };
    library.render();
    assert.equal(root.querySelector('[data-expose="core.library.app.operation"]').textContent, "0.0.9 적용하는 중");
    app = { ...app, operation: { state: "failed", version: "0.0.9", error: "application update: sha256 differs" } };
    library.render();
    const failed = root.querySelector('[data-expose="core.library.app.operation"]');
    assert.equal(failed.textContent, "0.0.9 업데이트하지 못했습니다: application update: sha256 differs");
    assert.equal(failed.getAttribute("role"), "alert");

    // A candidate without a release page offers no link, and without a candidate the list has no core row.
    app = { ...app, operation: null, available: { version: "0.0.9", release: null } };
    library.render();
    assert.deepEqual([...row().querySelectorAll("button")].map((b) => b.dataset.expose), ["core.library.app.update"]);
    app = { ...app, available: null, incompatible: [] };
    library.render();
    assert.equal(row(), null);
  } finally {
    dom.window.close();
  }
});
