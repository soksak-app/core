import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, W } from "./helpers.mjs";

/**
 * A sidebar is a card. So is a rail. What makes them what they are is which slot
 * they hold and that they hold it at a fixed width — there is no second kind of
 * object, and nothing to keep in step with the cards.
 */
const edges = (options = {}) =>
  new Soksak(
    {
      xs: [0, 1 / 3, 2 / 3, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 180, fixed: true },
        { id: "terminal", c0: 1, c1: 2, r0: 0, r1: 1 },
        { id: "browser", c0: 1, c1: 2, r0: 1, r1: 2 },
        { id: "right", c0: 2, c1: 3, r0: 0, r1: 2, width: 200, fixed: true },
      ],
    },
    { width: W, height: H, ...options },
  );

test("a card holding a slot takes px; the rest share what is left", () => {
  const grid = edges();
  const left = grid.rect("left");
  const right = grid.rect("right");
  const terminal = grid.rect("terminal");

  assert.equal(left.x, 0, "it starts at the plane's border");
  assert.equal(left.w, 180 - grid.gap / 2, "the room it holds, less the one inner inset");
  assert.equal(right.x + right.w, W, "the far one ends at the border");
  assert.equal(right.w, 200 - grid.gap / 2);

  assert.equal(terminal.x - (left.x + left.w), grid.gap, "one full corridor, like any two cards");
  assert.equal(right.x - (terminal.x + terminal.w), grid.gap);
  assertTiling(grid, "with two fixed cards");
});

test("the same card in a middle slot is a rail, and nothing can cross it", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.5, 0.75, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "terminal", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "browser", c0: 0, c1: 1, r0: 1, r1: 2 },
        { id: "rail", c0: 1, c1: 2, r0: 0, r1: 2, width: 190, fixed: true },
        { id: "editor", c0: 2, c1: 3, r0: 0, r1: 2 },
      ],
    },
    { width: W, height: H },
  );
  const rail = grid.rect("rail");
  assert.equal(rail.h, H, "it runs the full height");
  assert.equal(rail.w, 190 - grid.gap, "inset on both sides — it faces a card either way");
  assert.ok(rail.x > 0 && rail.x + rail.w < W, "it stands between cards, not at an edge");

  assert.deepEqual(grid.cardsCrossing("x", 1), [], "the structure is the guarantee");
  assert.deepEqual(grid.cardsCrossing("x", 2), []);
  assertTiling(grid, "with a rail between panes");
});

test("resizing the plane moves the sharing cards only", () => {
  const grid = edges();
  const before = { left: grid.rect("left").w, right: grid.rect("right").w, mid: grid.rect("terminal").w };
  grid.resize(W + 400, H);
  const after = { left: grid.rect("left").w, right: grid.rect("right").w, mid: grid.rect("terminal").w };

  assert.equal(after.left, before.left, "a fixed width is fixed");
  assert.equal(after.right, before.right);
  assert.equal(after.mid, before.mid + 400, "the sharing card took the whole change");
});

test("dragging the boundary beside a fixed card resizes that card", () => {
  const grid = edges();
  const divider = grid.dividers().find((d) => d.axis === "x" && d.line === 1);
  assert.equal(divider.resizes, "left", "the boundary says whose size it changes");

  const linesBefore = grid.lines("x");
  grid.moveBoundary("x", 1, 260);
  assert.equal(grid.card("left").width, 260, "the card's own size changed");
  assert.deepEqual(grid.lines("x"), linesBefore, "and the shared lines did not move");
  assert.equal(grid.rect("left").w, 260 - grid.gap / 2);
  assertTiling(grid, "after resizing the sidebar");
});

test("a fixed-size card cannot be cut along the axis it holds", () => {
  const grid = edges();
  assert.equal(grid.canSplit("left", "x"), false, "one slot, one size — two would need two values");
});

test("splitting across the held axis keeps the width for both halves", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.4, 1],
      ys: [0, 1],
      cards: [
        { id: "side", c0: 0, c1: 1, r0: 0, r1: 1, width: 180 },
        { id: "main", c0: 1, c1: 2, r0: 0, r1: 1 },
      ],
    },
    { width: W, height: H },
  );
  const born = grid.split("side", "y");
  assert.ok(born, "a fixed width does not stop a cut across it");
  assert.equal(grid.card(born).width, 180, "both halves still stand in that slot");
  assert.equal(grid.rect("side").w, grid.rect(born).w);
  assertTiling(grid, "after splitting a fixed-width card");
});

test("a moved sidebar keeps the width it was given", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.25, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "rail", c0: 0, c1: 1, r0: 0, r1: 2, width: 190 },
        { id: "terminal", c0: 1, c1: 2, r0: 0, r1: 1 },
        { id: "browser", c0: 1, c1: 2, r0: 1, r1: 2 },
      ],
    },
    { width: W, height: H },
  );
  assert.equal(grid.move("rail", "browser", "right"), true, "a rail is repositioned by move");
  assert.equal(grid.card("rail").width, 190, "and arrives the size it left");
  assert.ok(grid.rect("rail").x > grid.rect("browser").x, "on the side it was sent to");
  assertTiling(grid, "after the rail travelled");
});
