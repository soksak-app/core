// The prepared layout draws a change of the frame scale. The preparation holds the height of the first row that the next drawing will show, and the scale is
// applied to the document in that drawing. This way the title bar and the row that the host sets in the same transaction appear in the same frame
// (docs/spec/native-surfaces.md#title-bar-height).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-frame-text";

test("a frame factor change prepares the row of the next draw and writes the factor in that draw", { timeout: 5000 }, async (t) => {
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
  } });
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
  const compositor = await import("../compositor.js");
  const records = [];
  compositor.onCommit((record) => { records.push(record); });
  const root = document.documentElement;
  const drawnFactor = () => root.style.getPropertyValue("--frame-text");
  try {
    // The first drawing is not prepared (same as index.html).
    plane.adopt(plane.fresh());
    let held = null;
    plane.onLayout((made, draw, seated, titlebar) => { held = { made, draw, seated, titlebar }; });
    const before = drawnFactor();

    // What index.html does on a settings change: it measures the plane size again and draws.
    await settings.set({ textSize: 1.5 }, "common", "test");
    plane.setGap(settings.halfGap());
    plane.settle();
    assert.ok(held, "the factor change did not reach the layout receiver");
    assert.equal(held.titlebar, 54, "the preparation carries the 54px row that the draw at factor 1.5 shows");
    assert.equal(drawnFactor(), before, "the factor reached the document before the prepared draw");

    records.length = 0;
    compositor.publishAhead(held.made, held.seated, held.titlebar);
    assert.equal(records.at(-1).titlebar, 54, "the preparation record carries the row of the next draw");
    held.draw();
    assert.equal(drawnFactor(), "1.5", "the prepared draw writes the factor");
    compositor.publish();
    assert.equal(records.at(-1).drawn, true);
    assert.equal(records.at(-1).titlebar, 54, "the record after the draw carries the drawn row");

    // Lowering the scale shrinks the row. The reply of the window does not set the row.
    held = null;
    await settings.set({ textSize: 1 }, "common", "test");
    plane.setGap(settings.halfGap());
    plane.settle();
    assert.equal(held.titlebar, 40);
    assert.equal(drawnFactor(), "1.5", "the smaller factor reached the document before the prepared draw");
    held.draw();
    assert.equal(drawnFactor(), "1");
  } finally {
    dom.window.close();
  }
});
