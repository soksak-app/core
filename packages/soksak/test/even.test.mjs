import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, make } from "./helpers.mjs";

/**
 * The even arrangement replaces the arrangement with an equal grid of the cards in
 * their current order, with one empty card when no grid fits exactly
 * (packages/soksak/docs/layout.md#even-arrangement).
 */

/**
 * Makes the layout of the sequence in which the last card is split toward the right
 * and the bottom in turn: a run of splits toward the right alone outgrows the plane
 * at minSize, since every split halves the card that is split.
 */
function alternatingSplits(count) {
  const grid = make({ width: 2400, height: 1200 });
  let last = [...grid.rects().keys()][0];
  for (let i = 0; i < count; i++) {
    last = grid.splitToward(last, i % 2 ? "bottom" : "right");
    assert.ok(last, `split ${i} toward the right`);
  }
  return grid;
}

test("the even arrangement gives every cell the same drawn size", () => {
  const grid = alternatingSplits(6);
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
  const grid = alternatingSplits(3);
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
    { root: { cut: "x", kids: [{ share: 0.3333333333333333, node: { card: "a", fixed: false } }, { share: 0.3333333333333333, node: { card: "b", fixed: false } }, { share: 0.33333333333333337, node: { card: "c", fixed: false } }] } },
    { width: 200, height: 200, minSize: 96 },
  );
  const before = JSON.stringify(grid.toJSON());
  assert.equal(grid.arrange("even"), false);
  assert.equal(JSON.stringify(grid.toJSON()), before);
});

test("three cards over four give a third and a quarter each, and the rows halve the height", () => {
  const row = (ids, shares) => ({ cut: "x", kids: ids.map((card, i) => ({ share: shares[i], node: { card } })) });
  const grid = new Soksak({ root: { cut: "y", kids: [
    { share: 0.3, node: row(["a", "b", "c"], [0.2, 0.5, 0.3]) },
    { share: 0.7, node: row(["d", "e", "f", "g"], [0.1, 0.2, 0.3, 0.4]) },
  ] } }, { width: 1200, height: 800, gap: 0, minSize: 20 });
  grid.even();
  const near = (value, expected, what) => assert.ok(Math.abs(value - expected) < 0.01, `${what}: ${value}, not ${expected}`);
  for (const id of ["a", "b", "c"]) near(grid.rect(id).w, 400, `${id} takes a third`);
  for (const id of ["d", "e", "f", "g"]) near(grid.rect(id).w, 300, `${id} takes a quarter`);
  for (const id of ["a", "d"]) near(grid.rect(id).h, 400, `the row of ${id} takes half the height`);
});

test("a card added beside a run of an even level takes 1/(k+1) of the level", () => {
  // ADD(M, run, side) along the level: the card joins the level, not a cut of the run.
  const grid = new Soksak({ root: { cut: "x", kids: ["a", "b", "c"].map((card) => ({ share: 1 / 3, node: { card } })) } }, { width: 1200, height: 600, gap: 0, minSize: 20 });
  assert.equal(grid.insert(["a", "b"], "right", { card: "n" }), "n");
  const root = grid.toJSON().root;
  assert.deepEqual(root.kids.map((kid) => kid.node.card), ["a", "b", "n", "c"]);
  for (const kid of root.kids) assert.ok(Math.abs(kid.share - 0.25) < 1e-6, `share ${kid.share}`);
});
