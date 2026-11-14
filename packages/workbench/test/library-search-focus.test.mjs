// The host calls of the page are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md). The case is selected before
// the modules that read the host are imported, because they read it when they are imported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const wire = selectPageWire("library-search-focus");

// The page of the window is drawn in this document, which the modules read when they are imported.
const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true,
  addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
// The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js).
globalThis.devicePixelRatio = dom.window.devicePixelRatio;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
const planeEl = document.getElementById("plane");
Object.defineProperty(planeEl, "clientWidth", { value: 800 });
Object.defineProperty(planeEl, "clientHeight", { value: 600 });
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(style);

const { installEnvironment } = await import("../environment.js");
const { registry } = await import("../exposure.js");
const { flushEvents } = await import("../page-log.js");
const { bind, run } = await import("../commands.js");
const { keyboardOwed } = await import("../keyboard.js");
const { createBarTabs } = await import("../bar-tabs.js");
const { checkStoredLayout } = await import("../stored-layout.js");
const { adopt, capture, fresh, onLayout, settle } = await import("../plane.js");
const projects = await import("../projects.js");
const { createLibrary } = await import("../library.js");
const { coreChanged, installCoreExposure } = await import("../core-exposure.js");

// The replies of the host settle in the turns that follow the call, so a test waits one macrotask after a call that no promise of the page ends.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("the declared cmd+k command targets the shown library page and rejects a hidden library", { timeout: 5000 }, async () => {
  // The tab's plugin is not installed, so the tab is drawn as a placeholder and no surface is mounted.
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "fixture-search-focus", title: "main" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [] }), [], "the environment of the case is not loaded");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const shortcut = JSON.parse(readFileSync(new URL("../shortcuts.json", import.meta.url), "utf8")).shortcuts
    .find((row) => row.key === "cmd+k" && row.owner === "workbench");
  assert.ok(shortcut, "the workbench cmd+k row was not declared");
  // The operations of the plane that the project module calls when the start document names a project. The page layout of index.html answers
  // presented and empty, and the start with a project calls neither of them.
  onLayout((made, draw) => draw());
  projects.onSwitch({ check: checkStoredLayout, save: capture, load: adopt, update: settle });
  const library = createLibrary(document.getElementById("library"));
  // The rename state of the bar tabs. The bars of index.html draw the tabs, which this test does not draw, so the redraw of the strips has no effect here.
  const { renames } = createBarTabs({ projects, projectBar: document.getElementById("projectBar"), spaceBar: document.getElementById("spaceBar"),
    workarea: document.getElementById("workarea"), bind, run, redraw: () => {}, keyboardOwed, changed: coreChanged });
  try {
    // chrome reads the measures of the window bar and drawn waits for the layout queue of the page layout of index.html; no command of this test reads them.
    await installCoreExposure({ library, renames, chrome: () => null, drawn: async () => {} });

    await registry.run("core.library.search.focus", {});
    assert.equal(document.activeElement.dataset.expose, "core.library.search");

    library.actions.page("plugins");
    await settled();
    await registry.run(shortcut.command, {});
    assert.equal(document.activeElement.dataset.expose, "core.library.plugins.search");

    // The window starts with a project in its address, so the start document draws the project and the library is not shown.
    dom.reconfigure({ url: "http://localhost/?project=prj-search" });
    projects.begin({ common: {}, projects: [{
      id: "prj-search", title: "search", root: "/work/search", color: "#fff", named: 1, activeSpaceId: "spc-aaaaaa",
      spaces: [{ id: "spc-aaaaaa", title: "SPACE1", layout: fresh() }], settings: {},
    }], open: [] });
    await settled();
    await assert.rejects(registry.run(shortcut.command, {}), /library is not shown/);
    assert.equal(library.state().page, "plugins");
    assert.equal(document.activeElement.dataset.expose, "core.library.plugins.search");
    // The commands are events of the class call, which the gate counts; the flush sends the counts.
    await flushEvents();
    wire.finish();
  } finally {
    dom.window.close();
  }
});
