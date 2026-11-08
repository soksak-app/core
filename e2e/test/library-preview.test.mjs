import assert from "node:assert/strict";
import test from "node:test";
import { previewGaps, startPreviewPanes } from "../library-preview.mjs";

// The start layout of environment.json: the sidebars left and right and the cards terminal above browser between them. The start
// state replaces the placeholder tab of each card in turn, and adding a tab focuses its card, so the lower card holds the focus.
const grid = {
  cards: [
    { id: "left", x: 0, y: 0, w: 190, h: 800, fixed: true, tabs: [] },
    { id: "terminal", x: 190, y: 0, w: 800, h: 416, tabs: [{ id: "tab-upper" }], focused: false },
    { id: "browser", x: 190, y: 416, w: 800, h: 384, tabs: [{ id: "tab-lower" }], focused: true },
    { id: "right", x: 990, y: 0, w: 210, h: 800, fixed: true, tabs: [] },
  ],
};
// The preview draws equal rows and compact sidebar columns with one gap of 4 points.
const preview = [
  { id: "left", x: 10, y: 10, w: 20, h: 84 },
  { id: "terminal", x: 34, y: 10, w: 90, h: 40 },
  { id: "browser", x: 34, y: 54, w: 90, h: 40 },
  { id: "right", x: 128, y: 10, w: 20, h: 84 },
];

test("the start panes stand by the geometry of the grid, whichever card holds the focus", () => {
  const panes = startPreviewPanes(grid, preview);
  assert.deepEqual([panes.left.id, panes.upper.id, panes.lower.id, panes.right.id], ["left", "terminal", "browser", "right"]);
  assert.deepEqual(previewGaps(panes), [4, 4, 4]);
  const swapped = { cards: grid.cards.map((card) => ({ ...card, focused: card.id === "terminal" })) };
  assert.deepEqual(startPreviewPanes(swapped, preview), panes);
});

test("a start layout without two content cards in one column is refused", () => {
  const side = { cards: grid.cards.map((card) => card.id === "browser" ? { ...card, x: 590, y: 0, w: 400, h: 800 } : card) };
  assert.throws(() => startPreviewPanes(side, preview), /two content cards one above the other/);
});
