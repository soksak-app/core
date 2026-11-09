import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "soksak";
import { arrangeWindowSidebars, windowSidebarCards } from "../window-sidebars.js";

const ORDER = ["left", "right", "top", "bottom"];
const spans = (grid) => JSON.stringify(grid.cards.map(({ id, c0, c1, r0, r1, fixed }) => ({ id, c0, c1, r0, r1, fixed }))
  .sort((a, b) => (a.id < b.id ? -1 : 1)));

// The fixed sidebar of an edge keeps its place and its size while the focus moves between plugins whose overrides choose its content
// (docs/spec/external-sidebars.md).
for (const side of ORDER) test(`window ${side} sidebar retains its edge and size across plugin overrides`, () => {
  const units = [{ id: "alpha" }, { id: "beta" }];
  const links = [{ place: side, plugin: null, set: "general" }, ...units.map((unit) => ({ place: `window-${side}`, plugin: unit.id, set: unit.id }))];
  const grid = new Soksak({ xs: [0, 1], ys: [0, 1], cards: [{ id: "content", c0: 0, c1: 1, r0: 0, r1: 1 }] }, { width: 1000, height: 800 });
  const records = {};
  const arrange = (focus) => arrangeWindowSidebars(grid, ORDER, windowSidebarCards(units, links, focus).map((item) => item.id), records, 190,
    (shown) => shown === side);
  assert.equal(arrange("alpha"), true);
  assert.deepEqual(grid.cards.filter((card) => card.id !== "content").map((card) => card.id), [side]);
  const key = side === "left" || side === "right" ? "width" : "height";
  assert.deepEqual(records[side], { [key]: 190 });
  assert.equal(grid.setSize(side, side === "left" || side === "right" ? "x" : "y", 230), true);
  const before = spans(grid);
  assert.equal(arrange("beta"), false, "an override must not move the fixed sidebar");
  assert.equal(grid.card(side)[key], 230, "an override changed the size of the fixed sidebar");
  assert.deepEqual(records[side], { [key]: 230 }, "the record does not keep the size of the fixed sidebar");
  assert.equal(arrange(null), false, "the general choice must not move the fixed sidebar");
  assert.equal(grid.card(side)[key], 230, "the general choice changed the size of the fixed sidebar");
  assert.equal(spans(grid), before);
});
