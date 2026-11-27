// The head of a drawn window sidebar shows the position of its side in sidebarOrder, counted from 1, and its × turns the sidebar off with the
// scope of the side (docs/spec/external-sidebars.md#sidebar-head-and-edge).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const pluginId = "fixture-sidebar-head";
const setId = "fixture-set";

test("the head of the left window sidebar shows 1 and its × turns the sidebar off", { timeout: 5000 }, async () => {
  selectPageWire("overlay-none");
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.devicePixelRatio = 2;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: pluginId, title: "main" }] } } },
    sidebars: { sets: [{ id: setId, title: "Fixture", layout: "list", sections: [] }], links: [{ place: "left", plugin: null, set: setId }] },
  }, { plugins: [{ id: pluginId, package: "@fixture/sidebar-head", version: "0.0.1", folder: "/installed/plugin", manifest: {
    id: pluginId, name: "Fixture", description: "검사용 표면.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const { value } = await import("../settings.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    drawHeld();
    const side = document.querySelector('[data-card-id="left"]');
    assert.ok(side, "the left window sidebar is drawn");
    const order = value("sidebarOrder").indexOf("left") + 1;
    // The head row is the top row of the sidebar: the position, the name of the set, its layout badge and the × (docs/spec/external-sidebars.md#sidebar-head-and-edge).
    const head = side.querySelector(":scope > header.chrome.sidebar-head");
    assert.ok(head, "the sidebar has no head row");
    assert.equal(head.querySelector(".sidebar-head__order").textContent, String(order), "the head shows the position of the side in sidebarOrder");
    assert.equal(head.querySelector(".sidebar-head__name").textContent, "Fixture", "the head shows the name of the set");
    assert.equal(head.querySelector(".sidebar-head__layout").textContent, "목록", "the head shows the layout badge of the set");
    assert.equal(side.querySelector(":scope > .status"), null, "the sidebar keeps its status line below the head");
    const fold = head.querySelector(":scope > .sidebar-status__fold");
    assert.ok(fold, "the head has the × control");
    assert.equal(fold.dataset.expose, "core.sidebar.fold");
    assert.equal(fold.dataset.command, "core.settings.change");
    assert.equal(fold.dataset.side, "left");
  } finally {
    dom.window.close();
  }
});
