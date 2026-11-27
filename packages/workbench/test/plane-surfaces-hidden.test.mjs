// While the settings tab is in front, the native surfaces of the window are hidden the way a hidden tab hides its surface: no surface
// has a seat in the layout transaction (docs/spec/settings.md#opening-and-closing). Leaving the settings tab seats them again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const pluginId = "fixture-surfaces-hidden";

test("the surfaces of the window have no seat while the settings tab is in front", { timeout: 5000 }, async () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: pluginId, title: "only" }] } } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: pluginId, package: "@fixture/surfaces-hidden", version: "0.0.1", folder: "/installed/plugin", manifest: {
    id: pluginId, name: "Fixture", description: "Fixture surface.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  // The layout transaction receives the seats of this draw; the last one is kept for the checks.
  let seats = null;
  let draw = null;
  plane.onLayout((made, drawNow, seated) => { seats = seated; draw = drawNow; drawNow(); });
  plane.adopt(plane.fresh(), "spc-hidden00");
  plane.settle();
  assert.equal(seats.size, 1, "the tab of the card has a seat while the window shows its surfaces");

  plane.setSurfacesHidden(true);
  plane.settle();
  assert.equal(seats.size, 0, "no surface has a seat while the settings tab is in front");

  plane.setSurfacesHidden(false);
  plane.settle();
  assert.equal(seats.size, 1, "the seat returns when the settings tab leaves the front");
  assert.equal(typeof draw, "function");
});
