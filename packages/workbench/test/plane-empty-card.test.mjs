// The last tab that leaves a card that cannot close leaves the card empty: the card stays without tabs and without an active tab, and
// no tab of another plugin takes its place (docs/spec/cli.md#acting-on-a-layout, F1148-1).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { pageMemorySaver } from "./support/memory-saver.mjs";

const pluginId = "fixture-empty-card";

test("closing the only tab of the only card leaves the card empty", { timeout: 5000 }, async () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  // The size of the plane and the border width that app.css gives a card; JSDOM computes no layout and loads no stylesheet.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  // The environment of the page: one card with one tab of the plugin.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: pluginId, title: "only" }] } } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: pluginId, package: "@fixture/tab-close", version: "0.0.1", manifest: {
    id: pluginId, name: "Fixture", description: "Fixture surface.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    let held = null;
    plane.onLayout((made, draw) => { held = draw; });
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    held();
    await installCoreExposure({
      memorySaver: await pageMemorySaver(),
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
      drawn: async () => {},
    });
    const [only] = plane.currentGrid().card("main").data.tabs;
    assert.deepEqual(await registry.run("core.tab.close", { tab: only.id }), { closed: true });
    const main = plane.currentGrid().card("main");
    assert.ok(main, "the card that cannot close was closed");
    assert.deepEqual({ tabs: main.data.tabs, activeId: main.data.activeId }, { tabs: [], activeId: null },
      "the card took another tab instead of staying empty");
    // The empty card draws its head with the card tools, whose 탭 추가 opens a tab, and a body without a surface.
    held?.();
    const el = document.querySelector('[data-card-id="main"]');
    assert.ok(el?.querySelector('[data-expose="core.card.tools"]'), "the empty card has no card tools in its head");
    const slot = el.querySelector(":scope > .slot");
    assert.equal(slot.dataset.nativeSurfaceId, undefined, "the empty card seats a surface");
    assert.equal(slot.dataset.surfaceStatus, "empty");
    assert.equal(slot.querySelector(".surface-placeholder"), null, "the empty card shows a placeholder");
  } finally {
    delete globalThis.devicePixelRatio;
    dom.window.close();
  }
});
