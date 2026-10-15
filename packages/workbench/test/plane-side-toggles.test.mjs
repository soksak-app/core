// The sidebar button of a card header must not leave the document when the plane is redrawn. When the node that received a press leaves the document, WebKit
// clears the click target of that press (EventHandler::nodeWillBeRemoved) and sends no click on the release. Moving an existing node with insertBefore
// also removes it first. The layout of a collapse command is drawn in the next task after the preparation (F43, F92), so if that drawing comes between a press and a release,
// the click of the button is lost (F65).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-side-toggles";
const setId = "fixture-set";

test("a draw keeps the pressed card header fold control in the document", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  // matchMedia, which JSDOM does not have. The view uses it only to subscribe to resolution changes, and this test does not change the resolution.
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  // The sidebar strip is aligned to the device pixel grid. The screen scale of this test is 2.
  globalThis.devicePixelRatio = 2;
  // The size of the plane. JSDOM does not compute layout, so the test gives a size that holds two sidebars.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // The border width that the app stylesheet gives a card and the width of a collapsed sidebar. JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    mountSurface: () => Promise.resolve(),
    disposeSurface: () => Promise.resolve(), focusSurface: () => true, placePluginPlaceholder: () => {},
  } });
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "검사용 표면.", surface: true, sections: [] }],
  } });
  // One set without sections. It is attached to the top and left sides of the card.
  const actualSettings = await import("../settings.js");
  const sets = [{ id: setId, title: "Fixture", layout: "list", sections: [] }];
  t.mock.module("../settings.js", { exports: { ...actualSettings,
    value: (key) => (key === "sets" ? sets : actualSettings.value(key)) } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    // The receiver keeps the drawing function and does not draw immediately. This is the same as a page that waits for the native preparation and the next task.
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    plane.adopt(plane.fresh());
    drawHeld();
    for (const side of ["top", "left"]) {
      plane.assignSidebar("main", side, setId);
      drawHeld();
    }
    const card = document.querySelector('.card[data-card-id="main"]');
    const controls = () => [...card.querySelectorAll(".chrome__acts .chrome__side")].map((button) => button.dataset.side);
    assert.deepEqual(controls(), ["top", "left"], "the header does not show the top and left fold controls");
    const left = card.querySelector('.chrome__side[data-side="left"]');

    // The first press collapses the left side, and the drawing of that layout still waits. The drawing runs after the next press reaches the button.
    plane.foldSidebar("main", "left");
    const acts = left.parentElement;
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(acts, { childList: true });
    drawHeld();
    const removed = observer.takeRecords().flatMap((record) => [...record.removedNodes])
      .map((node) => node.dataset?.side ?? node.className);
    observer.disconnect();
    assert.deepEqual(removed, [], "the draw took fold controls out of the card header");
    assert.equal(card.dataset.sidebarLeft, "folded");
    assert.deepEqual(controls(), ["top", "left"], "the draw changed the order of the fold controls");
    assert.deepEqual(reports, []);
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
