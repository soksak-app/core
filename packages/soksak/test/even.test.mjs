import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, make } from "./helpers.mjs";

/**
 * The even arrangement replaces the arrangement with an equal grid of the cards in
 * their current order, with one empty card when no grid fits exactly
 * (packages/soksak/docs/layout.md#even-arrangement).
 */

/** Makes the layout of the sequence in which the rightmost card is split toward the right. */
function rightSplits(count) {
  const grid = make({ width: 2400, height: 1200 });
  let last = [...grid.rects().keys()][0];
  for (let i = 0; i < count; i++) {
    last = grid.splitToward(last, "right");
    assert.ok(last, `split ${i} toward the right`);
    grid.balance();
  }
  return grid;
}

test("the even arrangement gives every cell the same drawn size", () => {
  const grid = rightSplits(6);
  assert.equal(grid.cards.length, 7);

  assert.equal(grid.arrange("even"), true);
  assertTiling(grid, "after the even arrangement");

  // Seven cards fit a grid of eight cells with one empty card; 2 x 4 is the grid closest to square.
  const cards = grid.cards;
  assert.equal(cards.length, 8, "one empty card was added");
  const rects = [...grid.rects().values()];
  for (const rect of rects) {
    assert.ok(Math.abs(rect.w - rects[0].w) <= 1, `width ${rect.w} against ${rects[0].w}`);
    assert.ok(Math.abs(rect.h - rects[0].h) <= 1, `height ${rect.h} against ${rects[0].h}`);
  }
});

test("the even arrangement places the cards in their current order, row by row", () => {
  const grid = rightSplits(3);
  const order = grid.cards.map((card) => card.id);
  assert.equal(grid.arrange("even"), true);
  const columns = Math.max(...grid.cards.map((card) => card.c1));
  grid.cards.forEach((card, index) => {
    const at = order.indexOf(card.id);
    assert.equal(card.c0, at % columns, `${card.id} column`);
    assert.equal(card.r0, Math.floor(at / columns), `${card.id} row`);
  });
});

test("the even arrangement changes nothing when no grid keeps every cell at minSize", () => {
  // Three cards in one row on a 200 px square: every grid has cells under 96 px.
  const grid = new Soksak(
    {
      xs: [0, 1 / 3, 2 / 3, 1],
      ys: [0, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1, fixed: false },
        { id: "b", c0: 1, c1: 2, r0: 0, r1: 1, fixed: false },
        { id: "c", c0: 2, c1: 3, r0: 0, r1: 1, fixed: false },
      ],
    },
    { width: 200, height: 200, minSize: 96 },
  );
  const before = JSON.stringify(grid.toJSON());
  assert.equal(grid.arrange("even"), false);
  assert.equal(JSON.stringify(grid.toJSON()), before);
});
