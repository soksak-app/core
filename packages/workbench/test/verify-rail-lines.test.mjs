// Verification R measures the lines only when the plane is at the size it last drew. When a new layout replaces the awaited layout, the grid already has the new size and
// the lines are still drawn at the earlier size, so the test compares the extent of the drawn cards with the plane, not the size of the grid (F34).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

const rect = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

async function railRow(t, painted) {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"><article class="card" data-card-id="one"><div class="chrome"></div><div class="status"></div></article><div class="sp-rule"></div></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  t.after(() => dom.window.close());
  const plane = document.querySelector("#plane");
  // The window shrank, so the plane is already 400×300, and the lines are drawn on the earlier 700×300 plane.
  plane.getBoundingClientRect = () => rect(6, 6, 400, 300);
  document.querySelector("#stage").getBoundingClientRect = () => rect(0, 0, 412, 312);
  document.querySelector(".sp-rule").getBoundingClientRect = () => rect(6, 6, 700, 1);
  const grid = new Soksak(undefined, { width: 400, height: 300 });
  const [card] = grid.cards;
  t.mock.module("../compositor.js", { exports: { ahead: () => null, latest: () => ({ seq: 1, surfaces: [] }), placementPending: () => false, seated: () => null } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => grid, dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane,
    presentedCardRect: (id) => (id === card.id ? painted : undefined),
    railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4 } });
  const { verify } = await import(`../verify.js?${painted.w}`);
  return verify().find((row) => row.name.startsWith("R "));
}

test("rail lines are not measured while the plane shows a layout of an earlier size", async (t) => {
  const row = await railRow(t, { x: 0, y: 0, w: 700, h: 300 });
  assert.equal(row.ok, true, `lines of the earlier layout were measured against the new plane: ${row.note}`);
  assert.equal(row.note, "판이 아직 새 크기로 그려지지 않았다");
});

test("rail lines beyond the margin fail when the plane shows its current size", async (t) => {
  const row = await railRow(t, { x: 0, y: 0, w: 400, h: 300 });
  assert.equal(row.ok, false);
  assert.match(row.note, /최대 300\.00px/);
});
