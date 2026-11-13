// The section surface ids of the sidebars that the plane draws take the space of the layout that the plane holds
// (docs/spec/plugins.md#sections). A project close turns the project state to the library before it clears the plane, and a
// draw in that time still draws the sidebars of the layout of the closed space.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const pluginId = "fixture-space";
const setId = "fixture-space-set";

test("a sidebar draws the section surface ids of the space of the held layout while the project state shows the library", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.devicePixelRatio = 2;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // The border width and the width of a collapsed sidebar that app.css gives a card; JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // The page has no host in this test, so it is not native: the surfaces are placeholders, and no call reaches a host.
  // Without a host, report writes the error to console.error and stores no record, so the test keeps this replacement of
  // the report to observe the errors that the plane reports.
  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  // The environment of the page: the plugin with its section, and the sidebar set that names the section. The environment is
  // installed before the page draws, and no project is open, so the project state shows the library.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } },
    sidebars: { sets: [{ id: setId, title: "Fixture", layout: "list", sections: [`${pluginId}.tree`] }], links: [] },
  }, { plugins: [{ id: pluginId, package: "@fixture/space", version: "0.0.1", manifest: {
    id: pluginId, name: "Fixture", description: "검사용 표면.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
    sections: [{ id: `${pluginId}.tree`, name: "Tree", height: "fill", composition: { kind: "view", page: "ui/tree.html" } }],
  } }] }), [], "the fixture environment refused a plugin");

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    drawHeld();
    plane.assignSidebar("main", "left", setId);
    drawHeld();
    const ids = [...document.querySelectorAll(".set__body")].map((body) => body.dataset.nativeSurfaceId);
    assert.deepEqual(ids, ["spc-aaaaaa/main:left/fixture-space.tree"]);
    assert.deepEqual(reports, []);
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
