// After the plane builds a layout, it passes a drawing function to the onLayout receiver, and the receiver calls that function after the native preparation
// finishes. If the last tab of a closable card closes in between, the card disappears from the plane, but the drawing function that was passed still holds the earlier layout that
// contained that card. That drawing must finish without an exception (G1.4-26).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-stale-layout";

test("a held layout draw survives the close of a card it contains", { timeout: 5000 }, async (t) => {
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
  // The size of the plane. JSDOM does not compute layout, so the test gives a size that has space to split.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  // The border width that the app stylesheet gives a card and the width of a collapsed sidebar. JSDOM does not load app.css.
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // A page without a host bridge. The test records the reports so that it can read them.
  const reports = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => reports.push(line) } });
  // The test does not load surface modules. It handles only the drawing of the plane. It records the surfaces that are mounted.
  const mounts = [];
  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    surfaceForTab: (tab) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId: tab.id,
      pluginId: tab.plugin, declarations: {}, sidecars: [] }),
    mountSurface: (slot, surface) => { mounts.push(surface.surfaceId); return Promise.resolve(); },
    disposeSurface: () => Promise.resolve(), placePluginPlaceholder: () => {},
  } });
  // The layout of a new space: one card that cannot be closed.
  t.mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "검사용 표면.", surface: true, sections: [] }],
  } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });

  // The card elements connect only to declared core commands.
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  try {
    // The receiver keeps the drawing function and does not draw immediately. This is the same as a page that waits for the native preparation.
    let held = null;
    plane.onLayout((made, draw) => { held = { made, draw }; });
    plane.adopt(plane.fresh());
    held.draw();
    // The drawing of a live card mounts the surface of its tab.
    const mainTab = plane.currentGrid().card("main").data.activeId;
    assert.ok(mounts.includes(mainTab), `the first draw did not mount the main tab ${mainTab}`);
    const { card, tab } = plane.splitCard("main", "right", pluginId);
    assert.ok(plane.currentGrid().card(card), "the split made no card");
    const stale = held;
    assert.ok(stale.made.has(card), "the held layout does not contain the split card");
    await plane.closeTabById(tab);
    assert.equal(plane.currentGrid().card(card), undefined, "closing the last tab left the card on the plane");
    mounts.length = 0;
    assert.doesNotThrow(() => stale.draw(), "drawing a layout held before the card closed must not throw");
    // The surface of the closed tab is already released, so drawing the earlier layout does not mount it again.
    assert.ok(!mounts.includes(tab), `the closed tab ${tab} was mounted again by the stale draw`);
    assert.deepEqual(reports, []);
  } finally {
    dom.window.close();
  }
});
