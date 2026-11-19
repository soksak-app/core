// The gap setting is the full distance between two adjacent cards, and the margin of the stage is half of it (the values of
// docs/spec/settings.md#values).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the gap setting is the distance between two adjacent cards", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  t.after(() => dom.window.close());
  // JSDOM has no layout, so the test gives the plane its size.
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 800 });
  Object.defineProperty(planeEl, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const { installEnvironment } = await import("../environment.js");
  const refused = installEnvironment({
    runtime: "runtime",
    workspace: { focus: "one", grid: {
      xs: [0, 0.5, 1], ys: [0, 1],
      cards: [
        { id: "one", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "fixture-gap", title: "one" }] },
        { id: "two", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [{ plugin: "fixture-gap", title: "two" }] },
      ],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [] });
  assert.deepEqual(refused, []);
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const memory = { common: {}, projects: [] };
  const settings = await import("../settings.js");
  await settings.connectSettings({
    snapshot: async () => structuredClone(memory),
    settings: async (id, values) => { memory.common = { ...memory.common, ...values }; },
    onChange: () => () => {},
  });
  const plane = await import("../plane.js");
  plane.adopt(plane.fresh(), "spc-aaaaaa");

  // What index.html does on a settings change: it gives the plane the gap of the settings and draws.
  const change = async (gap) => {
    await settings.set({ gap }, "common", "test");
    plane.setGap(settings.halfGap());
    plane.settle();
    const grid = plane.currentGrid();
    const left = grid.rect("one"), right = grid.rect("two");
    return { gap: grid.gap, between: right.x - (left.x + left.w), pad: settings.stagePad() };
  };
  assert.deepEqual(await change(12), { gap: 12, between: 12, pad: 6 }, "a gap of 12 does not put 12 between the cards");
  assert.deepEqual(await change(7), { gap: 7, between: 7, pad: 3.5 }, "a gap of 7 does not put 7 between the cards");
  // At 0 the two cards share one line: the plane gap is the border width of the theme and the stage has no margin.
  assert.deepEqual(await change(0), { gap: settings.borderWidth(), between: settings.borderWidth(), pad: 0 },
    "a gap of 0 does not leave one shared line between the cards");
});
