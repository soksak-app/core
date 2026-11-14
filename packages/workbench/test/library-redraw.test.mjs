// When the library is redrawn, the operation elements of cards that did not change stay in the document (docs/spec/exposure.md). If the
// pressed element leaves the document between a press and a release, WebKit does not send a click (F66.1).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

// The host calls of the page are answered by the page-wire case of this file (docs/spec/cases/page-wire/README.md). The case is selected
// once, before the modules are imported, because the library and the plugin operations take the host of the page when they are imported;
// its steps are the calls of the two tests in the order of the tests.
const wire = selectPageWire("library-redraw-controls");
// The plane binds the elements of the workbench document when it is imported, so the document is the one of index.html.
const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.location = dom.window.location;
globalThis.devicePixelRatio = dom.window.devicePixelRatio;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
const { installExposure } = await import("../exposure.js");
installExposure(exposureFile);
const { begin } = await import("../projects.js");
const { createLibrary } = await import("../library.js");
const { flushEvents } = await import("../page-log.js");
// The replies of the host settle after the turn of the page that sent their calls.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a library render keeps the controls of unchanged project cards in the document", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const projects = [
    { id: "prj-a", title: "a", root: "/usr/bin", spaces: [{ id: "s" }], activeSpaceId: "s" },
    { id: "prj-b", title: "b", root: "/usr/lib", spaces: [{ id: "s" }], activeSpaceId: "s" },
  ];
  // The window starts with the two projects in its store snapshot, so the library lists them (docs/spec/native-host.md#page-start).
  begin({ common: {}, projects, open: [] });
  await settled();
  const library = createLibrary(root);
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
  root.remove();
});

test("a plugin page render keeps the controls of unchanged plugin cards in the document", async () => {
  // The plugin state, the outdated sidecars and the application state are the host replies of the case.
  const root = document.createElement("div");
  document.body.append(root);
  begin({ common: {}, projects: [], open: [] });
  const library = createLibrary(root);
  await library.actions.page("plugins");
  // The replies of the host settle after one turn of the page, which the library reads before it draws the rows.
  await settled();
  library.render();
  const buttons = [...root.querySelectorAll('[data-expose="core.library.plugins.action"]')];
  assert.ok(buttons.length > 0, "the plugin page drew no action controls");
  library.render();
  assert.ok(buttons.every((button) => button.isConnected), "a render of unchanged plugins took action controls out of the document");
  await flushEvents();
  root.remove();
  wire.finish();
});
