import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// A removed project withdraws its folder error, so the same project added again with the same missing folder reports the error again.
test("a removed project hides its folder error, and the error is written again when the project is added again", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  const project = { id: "prj-a", title: "test", root: "/work/missing", spaces: [{ id: "s" }], activeSpaceId: "s" };
  let listed = [project];
  const reports = [];
  t.mock.module("../host.js", { namedExports: { report: (line) => { reports.push(line); } } });
  t.mock.module("../projects.js", { namedExports: {
    inLibrary: () => true, all: () => listed, isOpen: () => false, active: () => null,
    close: async () => {},
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
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: { hosted: false, status: () => ({ plugins: [], operation: null }), failure: () => null, refresh: async () => {} },
    onPluginOperations: () => {},
    appUpdate: { status: () => ({ version: null, available: null, operation: null, error: null }), refresh: async () => {} },
  } });
  const { createLibrary } = await import("../library.js?removed-project");
  const library = createLibrary(document.getElementById("library"));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const written = () => reports.filter((line) => line.startsWith("library project /work/missing: "));
  // The project is added and its folder is missing. The error is written once.
  library.render();
  await settle();
  assert.equal(written().length, 1, "the missing folder error is not written when the project is added");
  // The project leaves the library list. Its card and its folder result are removed.
  listed = [];
  library.refreshFolders();
  library.render();
  await settle();
  assert.equal(document.querySelector('[data-project-id="prj-a"]'), null, "the card of a removed project is still shown");
  // The same project is added again with the same missing folder. The error is written again.
  listed = [project];
  library.refreshFolders();
  library.render();
  await settle();
  assert.equal(written().length, 2, "the error of a project added again is not written");
  dom.window.close();
});
