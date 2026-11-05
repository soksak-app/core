// A press on a card is the scope of the text size while the card is in the plane and the plane shows its space
// (docs/spec/text-size.md#scope). The press on a frame stays.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-text-scope";

test("the scope of a pressed card ends with the card and its space", { timeout: 30000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    mountSurface: () => Promise.resolve(), disposeSurface: () => Promise.resolve(),
    placePluginPlaceholder: () => {},
    surfaceForTab: (tab) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId: tab.id,
      pluginId: tab.plugin, params: tab.params ?? null, declarations: {}, sidecars: [] }),
  } });
  t.mock.module("../environment.js", { exports: { refusedPlugins: () => new Set(),
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 0.5, 1], ys: [0, 1],
      cards: [
        { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] },
        { id: "other", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "other" }] },
      ],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "검사용 표면.", surface: true, sections: [] }],
  } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);

  const memory = { common: {}, projects: [] };
  const settings = await import("../settings.js");
  await settings.connectSettings({
    snapshot: async () => structuredClone(memory),
    settings: async (_id, values) => { memory.common = { ...memory.common, ...values }; },
    onChange: () => () => {},
  });
  const plane = await import("../plane.js");
  const { setTextScope, textScope } = await import("../text-size.js");

  // Presses the focused card, which runs no command of the focus.
  const press = (card) => {
    plane.focusCard(card);
    plane.settle();
    const element = document.querySelector(`[data-card-id="${card}"]`);
    assert.ok(element, `card ${card} is not drawn`);
    element.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
    assert.deepEqual(textScope(), { kind: "card", card });
  };

  try {
    await t.test("a closed card leaves the scope to the focused card", async () => {
      plane.adopt(plane.fresh(), "spc-aaaaaa");
      press("other");
      plane.closeCard("other");
      assert.deepEqual(plane.currentTextScope(), { kind: "card", card: "main" });
      await plane.changeTextSize(1, "test");
      assert.equal(plane.cardTextSizes().main, 1.1);
    });
    await t.test("another space does not take the press of a card of the same id", async () => {
      plane.adopt(plane.fresh(), "spc-bbbbbb");
      press("other");
      plane.focusCard("main");
      plane.adopt(plane.fresh(), "spc-cccccc");
      assert.deepEqual(plane.currentTextScope(), { kind: "card", card: "main" });
      await plane.changeTextSize(1, "test");
      assert.equal(plane.cardTextSizes().main, 1.1);
      assert.equal(plane.cardTextSizes().other, 1);
    });
    await t.test("a press on a card stays when its space draws again", () => {
      plane.adopt(plane.fresh(), "spc-dddddd");
      press("other");
      plane.focusCard("main");
      plane.adopt(plane.capture(), "spc-dddddd");
      assert.deepEqual(plane.currentTextScope(), { kind: "card", card: "other" });
    });
    await t.test("the plane that leaves takes the press of a card with it", () => {
      plane.adopt(plane.fresh(), "spc-eeeeee");
      press("other");
      plane.clear();
      assert.equal(textScope(), null);
    });
    await t.test("another space keeps the press of the frame", () => {
      plane.adopt(plane.fresh(), "spc-ffffff");
      setTextScope({ kind: "frame" });
      plane.adopt(plane.fresh(), "spc-gggggg");
      assert.deepEqual(plane.currentTextScope(), { kind: "frame" });
    });
  } finally {
    dom.window.close();
  }
});
