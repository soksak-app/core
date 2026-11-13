// When the library is redrawn, the operation elements of cards that did not change stay in the document (docs/spec/exposure.md). If the
// pressed element leaves the document between a press and a release, WebKit does not send a click (F66.1).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { installExposure } from "../exposure.js";
import exposureFile from "../exposure.json" with { type: "json" };

installExposure(exposureFile);

test("a library render keeps the controls of unchanged project cards in the document", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.location = dom.window.location;
  const projects = [
    { id: "prj-a", title: "a", root: "/work/a", spaces: [{ id: "s" }], activeSpaceId: "s" },
    { id: "prj-b", title: "b", root: "/work/b", spaces: [{ id: "s" }], activeSpaceId: "s" },
  ];
  // The window starts with the two projects in its store snapshot, so the library lists them (docs/spec/native-host.md#page-start).
  const { begin } = await import("../projects.js");
  begin({ common: {}, projects, open: [] });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  t.mock.module("@soksak/runtime", { namedExports: { host: null, windows: { createsFolders: false,
    folder: async (root) => ({ root, identity: "id" }) } } });
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: { hosted: false, status: () => ({ plugins: [], operation: null, outdated: [], updates: [] }), failure: () => null, refresh: async () => {}, refreshOutdated: async () => {} },
    onPluginOperations: () => {},
    appUpdate: { status: () => ({ version: null, available: null, operation: null, error: null }), refresh: async () => {} },
  } });
  const { createLibrary } = await import("../library.js?redraw");
  const library = createLibrary(document.getElementById("library"));
  library.render();
  await library.idle();
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
  await library.idle();
  for (const record of watch.takeRecords()) for (const node of record.removedNodes) {
    if (node.nodeType === 1 && (node.matches?.("button") || node.querySelector?.("button"))) removed.push(node.className);
  }
  watch.disconnect();
  assert.deepEqual(removed, [], "a render of unchanged projects took card controls out of the document");
  assert.ok(controls.every((control) => control.isConnected), "a card control of the first render is no longer in the document");
  dom.window.close();
});

test("a plugin page render keeps the controls of unchanged plugin cards in the document", async (t) => {
  // The plugin state, the outdated sidecars and the application state are the host replies of the case. The case is selected before the
  // plugin modules are imported, because the plugin operations take the host of the page when they are made.
  const wire = selectPageWire("library-redraw-plugins");
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  const { begin } = await import("../projects.js");
  begin({ common: {}, projects: [], open: [] });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  const { createLibrary } = await import("../library.js?redraw-plugins");
  const library = createLibrary(document.getElementById("library"));
  await library.actions.page("plugins");
  // The replies of the host settle after one turn of the page, which the library reads before it draws the rows.
  await new Promise((resolve) => setImmediate(resolve));
  library.render();
  const buttons = [...document.querySelectorAll('[data-expose="core.library.plugins.action"]')];
  assert.ok(buttons.length > 0, "the plugin page drew no action controls");
  library.render();
  assert.ok(buttons.every((button) => button.isConnected), "a render of unchanged plugins took action controls out of the document");
  wire.finish();
  dom.window.close();
});
