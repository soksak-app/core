// The sidebar button of a card header must not leave the document when the plane is redrawn. When the node that received a press leaves the document, WebKit
// clears the click target of that press (EventHandler::nodeWillBeRemoved) and sends no click on the release. Moving an existing node with insertBefore
// also removes it first. The layout of a collapse command is drawn in the next task after the preparation (F43, F92), so if that drawing comes between a press and a release,
// the click of the button is lost (F65).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

const pluginId = "fixture-side-toggles";
const setId = "fixture-set";

test("a draw keeps the pressed card header fold control in the document", { timeout: 5000 }, async () => {
  // The host calls of the page are answered by the page-wire case (docs/spec/cases/page-wire/README.md). The case is selected before the modules of the page
  // are imported, because host.js reads the host when it is imported.
  const wire = selectPageWire("plane-side-toggles");
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
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

  // The environment of the page: the plugin with its card tab, and the sidebar set that the card header shows at the top and left sides.
  // The environment is installed before the page draws, and no project is open.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } },
    sidebars: { sets: [{ id: setId, title: "Fixture", layout: "list", sections: [] }], links: [] },
  }, { plugins: [{ id: pluginId, package: "@fixture/side-toggles", version: "0.0.1", manifest: {
    id: pluginId, name: "Fixture", description: "검사용 표면.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const { flushEvents } = await import("../page-log.js");
  try {
    // The receiver keeps the drawing function and does not draw immediately. This is the same as a page that waits for the native preparation and the next task.
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    const drawHeld = () => { const draw = held; held = null; draw(); };
    plane.adopt(plane.fresh(), "spc-aaaaaa");
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
    // The window closes here: the focus leaves the document, which the keyboard of the page records as an event that the gate counts.
    dom.window.close();
    await new Promise((resolve) => setImmediate(resolve));
    await flushEvents();
    assert.deepEqual(wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload).map(shownRecord)), [], "the plane reported an error");
    wire.finish();
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
