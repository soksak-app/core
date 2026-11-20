import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";

/**
 * The rules of sizes work on the fractions of the stored tree
 * (packages/soksak/docs/layout.md#the-model): a cut first takes its fixed costs,
 * the corridors between its kids, the px sizes and the frames and heads of the
 * boxes, and each kid that takes a fraction is drawn that fraction of the rest.
 */

const widths = (grid) => Object.fromEntries([...grid.rects()].map(([id, r]) => [id, r.w]));
const near = (actual, expected, note) => assert.ok(Math.abs(actual - expected) < 1e-9, `${note}: ${actual}, not ${expected}`);

test("equal fractions draw equal sizes beside a box, inside its frame", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { box: "g", inner: { card: "a" } } }, { share: 0.5, node: { card: "b" } }] } },
    { width: 1000, height: 600, gap: 24, minSize: 96 },
  );
  // The corridor and the frame on both sides of `a` are costs of the cut: 1000 - 24 - 48 leaves 928, 464 each.
  near(grid.rect("a").w, 464, "a inside the frame");
  near(grid.rect("b").w, 464, "b beside the box");
  near(grid.rect("a").x, 24, "the frame stands one corridor inside the box");
  assert.deepEqual(grid.rect("g"), { x: 0, y: 0, w: 512, h: 600 }, "the box is drawn around its frame");
});

test("equal fractions draw equal sizes at the border and between two corridors", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 1 / 3, node: { card: "a" } }, { share: 1 / 3, node: { card: "b" } }, { share: 1 / 3, node: { card: "c" } }] } },
    { width: 1000, height: 600, gap: 24, minSize: 96 },
  );
  for (const [id, w] of Object.entries(widths(grid))) near(w, (1000 - 48) / 3, id);
});

test("a gap change keeps every fraction, so an ADD and a REMOVE around it restore an even level exactly", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "b" } }, { share: 0.5, node: { card: "c" } }] } }] } },
    { width: 1000, height: 600, gap: 24, minSize: 96 },
  );
  const state = grid.toJSON();
  const was = widths(grid);
  grid.insert("a", "right", { card: "n" });
  const added = JSON.stringify(grid.toJSON());
  for (const gap of [0, 7, 40]) {
    grid.gap = gap;
    assert.equal(JSON.stringify(grid.toJSON()), added, `gap ${gap} keeps the fractions`);
  }
  grid.withdraw("n");
  grid.gap = 24;
  assert.deepEqual(grid.toJSON(), state, "the fractions are back exactly");
  for (const [id, w] of Object.entries(widths(grid))) near(w, was[id], id);
});

test("a dock and a hide on an even level restore the level exactly", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "b" } }] } },
    { width: 1000, height: 600, gap: 24, minSize: 96 },
  );
  const state = grid.toJSON();
  const was = widths(grid);
  assert.equal(grid.insertAt("x", 1, { id: "rail", size: 190 }), "rail");
  assert.equal(grid.close("rail"), true);
  assert.deepEqual(grid.toJSON(), state, "the fractions are back");
  for (const [id, w] of Object.entries(widths(grid))) near(w, was[id], id);
});

test("an ADD and a REMOVE on an even level restore the level exactly", () => {
  const grid = new Soksak(
    { root: { cut: "y", kids: [{ share: 1 / 3, node: { card: "a" } }, { share: 1 / 3, node: { card: "b" } }, { share: 1 / 3, node: { card: "c" } }] } },
    { width: 900, height: 1000, gap: 24, minSize: 96 },
  );
  const state = grid.toJSON();
  const was = [...grid.rects()];
  grid.insert("b", "bottom", { card: "n" });
  for (const kid of grid.toJSON().root.kids) near(kid.share, 0.25, "the even level stays even: the new card has 1/(k+1)");
  grid.withdraw("n");
  assert.deepEqual(grid.toJSON(), state, "the fractions are back exactly");
  assert.deepEqual([...grid.rects()], was);
});

test("a fixed card without a px size keeps its drawn size when a card arrives beside it", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.28, node: { card: "side", fixed: true } }, { share: 0.72, node: { card: "main" } }] } },
    { width: 1600, height: 1200, gap: 24, minSize: 96 },
  );
  const side = grid.rect("side").w;
  assert.equal(grid.insertAt("x", 1, { id: "rail", size: 400 }), "rail");
  near(grid.rect("side").w, side, "the fixed card is a cost of the cut");
  near(grid.rect("main").w, 1600 - side - 400 - 48, "the card that takes a fraction pays");
});

test("a kid whose fraction is less than the corridors inside it is drawn those corridors, and the others share the rest", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.01, node: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "b" } }] } }, { share: 0.5, node: { card: "c" } }] } }, { share: 0.99, node: { card: "d" } }] } },
    { width: 1000, height: 600, gap: 24, minSize: 96 },
  );
  // The column holds one corridor between `a` and `b`, so it is drawn 24 wide, and `d` stands one corridor beside it.
  assert.deepEqual(grid.rect("c"), { x: 0, y: grid.rect("c").y, w: 24, h: grid.rect("c").h });
  assert.equal(grid.rect("b").x, 24);
  assert.equal(grid.rect("d").x, 48);
  assert.equal(grid.rect("d").w, 952);
});
