import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// A missing folder is reported once for its project entry. While the library checks the folder again after each project list change, the last known result stays on the card, so the error display is not withdrawn and written again.
test("a missing project folder is reported once across project list changes, and a folder that appears again hides the error", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  const project = { id: "prj-a", title: "test", root: "/work/missing", spaces: [{ id: "s" }], activeSpaceId: "s" };
  let missing = true;
  const reports = [];
  t.mock.module("../host.js", { namedExports: { report: (line) => { reports.push(line); } } });
  t.mock.module("../projects.js", { namedExports: {
    inLibrary: () => true, all: () => [project], isOpen: () => false, active: () => null,
    close: async () => {},
  } });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  t.mock.module("@soksak/runtime", { namedExports: { host: null, windows: { createsFolders: false,
    folder: async (root) => {
      if (root === "/work/missing" && missing) throw new Error("project directory does not exist: /work/missing");
      return { root, identity: "id" };
    } } } });
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
    appUpdate: { status: () => ({ version: null, available: null, operation: null, error: null }), refresh: async () => {} },
  } });
  const { createLibrary } = await import("../library.js?folders-once");
  const library = createLibrary(document.getElementById("library"));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const written = () => reports.filter((line) => line.startsWith("library project /work/missing: "));
  library.render();
  await settle();
  // The project list changes three times. Each change checks the folder again and renders the library.
  for (let i = 0; i < 3; i++) {
    library.refreshFolders();
    library.render();
    await settle();
  }
  assert.deepEqual(written(), ["library project /work/missing: 폴더가 없습니다."],
    "the missing folder error is not written once");
  // The folder appears again. The next check finds no error, so the error display is withdrawn.
  missing = false;
  library.refreshFolders();
  library.render();
  await settle();
  const card = document.querySelector('[data-project-id="prj-a"]');
  assert.equal(card.querySelector(".library-project__missing"), null, "the error of a folder that appeared again is still shown");
  assert.equal(card.querySelector('[data-expose="core.library.open"]').disabled, false);
  // The folder disappears again. The error is shown and written once more.
  missing = true;
  library.refreshFolders();
  library.render();
  await settle();
  assert.equal(written().length, 2, "the error of a folder that disappeared again is not written");
  dom.window.close();
});

// For a project whose folder cannot be read, the library shows the reason before it opens, reports it to core.library, and allows removing the project from the library.
test("a project whose folder cannot be read shows the reason in the library and can be removed there", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  const project = { id: "prj-a", title: "test", root: "/work/missing", spaces: [{ id: "s" }], activeSpaceId: "s" };
  const closed = [];
  const present = { id: "prj-b", title: "here", root: "/work/here", spaces: [{ id: "s" }], activeSpaceId: "s" };
  t.mock.module("../projects.js", { namedExports: {
    inLibrary: () => true, all: () => [project, present], isOpen: () => false, active: () => null,
    close: async (id) => { closed.push(id); },
  } });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  t.mock.module("@soksak/runtime", { namedExports: { host: null, windows: { createsFolders: false,
    folder: async (root) => {
      if (root === "/work/missing") throw new Error("project directory does not exist: /work/missing");
      return { root, identity: "id" };
    } } } });
  t.mock.module("../library-preview.js", { namedExports: { preview: () => {
    const el = document.createElement("div"); el.className = "library-preview"; return el;
  } } });
  t.mock.module("../commands.js", { namedExports: { delegate: () => {}, mark: (element, command, params) => {
    element.dataset.command = command; element.dataset.params = JSON.stringify(params);
  } } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  // The operation state that the plugin page of the library uses. This test looks only at the project page.
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: { hosted: false, status: () => ({ plugins: [], operation: null }), failure: () => null, refresh: async () => {} },
    onPluginOperations: () => {},
    appUpdate: { status: () => ({ version: null, available: null, operation: null, error: null }), refresh: async () => {} },
  } });
  const { createLibrary } = await import("../library.js?folders");
  const library = createLibrary(document.getElementById("library"));
  library.render();
  await new Promise((resolve) => setImmediate(resolve));
  const state = library.state();
  assert.deepEqual(state.folderErrors, { "prj-a": "project directory does not exist: /work/missing" });
  const card = document.querySelector('[data-project-id="prj-a"]');
  // The path appears only once, in the path line of the card.
  assert.equal(card.querySelector(".library-project__missing")?.textContent, "폴더가 없습니다.");
  assert.equal(document.querySelector('[data-project-id="prj-b"] .library-project__missing'), null);
  assert.equal(card.querySelector('[data-expose="core.library.open"]').disabled, true, "the card of a missing folder can still be pressed");
  assert.equal(document.querySelector('[data-project-id="prj-b"] [data-expose="core.library.open"]').disabled, false);
  const remove = card.querySelector('[data-expose="core.library.remove"]');
  assert.deepEqual([remove?.dataset.command, remove?.dataset.params], ["core.library.remove", JSON.stringify({ id: "prj-a" })],
    "the library card has no remove control bound to core.library.remove");
  await library.actions.remove("prj-a");
  assert.deepEqual(closed, ["prj-a"]);
  dom.window.close();
});
