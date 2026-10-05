import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, W } from "./helpers.mjs";

/**
 * Balancing keeps the arrangement and gives every card a fair share: a cut gives
 * each side the share of the cards it holds along that axis, counted on the row
 * that holds the most of them.
 */
const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} and ${b} differ`);
const same = (grid, ids, key, label) => {
  const sizes = ids.map((id) => grid.rect(id)[key]);
  for (const size of sizes) near(size, sizes[0], `${label} ${ids.join(",")} ${sizes.join(",")}`);
};
const order = (grid) =>
  [...grid.rects()].map(([id, r]) => `${id}:${Math.round(r.x)},${Math.round(r.y)}`).sort();
const neighbours = (grid) => {
  const rects = [...grid.rects()];
  const pairs = [];
  for (const [a, ra] of rects) {
    for (const [b, rb] of rects) {
      if (a < b && (Math.abs(ra.x + ra.w + grid.gap - rb.x) < 1 || Math.abs(rb.x + rb.w + grid.gap - ra.x) < 1 ||
          Math.abs(ra.y + ra.h + grid.gap - rb.y) < 1 || Math.abs(rb.y + rb.h + grid.gap - ra.y) < 1)) {
        const overlapX = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
        const overlapY = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
        if (overlapX > 0 || overlapY > 0) pairs.push(`${a}|${b}`);
      }
    }
  }
  return pairs.sort();
};

test("three cards over four give a third and a quarter each, and the rows halve the height", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.1, 0.2, 0.45, 0.5, 0.9, 1],
      ys: [0, 0.2, 1],
      cards: [
        { id: "1", c0: 0, c1: 2, r0: 0, r1: 1 },
        { id: "2", c0: 2, c1: 4, r0: 0, r1: 1 },
        { id: "3", c0: 4, c1: 6, r0: 0, r1: 1 },
        { id: "4", c0: 0, c1: 1, r0: 1, r1: 2 },
        { id: "5", c0: 1, c1: 3, r0: 1, r1: 2 },
        { id: "6", c0: 3, c1: 5, r0: 1, r1: 2 },
        { id: "7", c0: 5, c1: 6, r0: 1, r1: 2 },
      ],
    },
    { width: W, height: H },
  );
  const before = neighbours(grid);
  grid.balance();
  same(grid, ["1", "2", "3"], "w", "the upper row");
  same(grid, ["4", "5", "6", "7"], "w", "the lower row");
  same(grid, ["1", "4"], "h", "the rows");
  near(grid.rect("1").w * 3 + 2 * grid.gap, W, "the upper row fills the plane");
  assert.deepEqual(neighbours(grid), before, "the arrangement is kept");
  assertTiling(grid, "after balance");
});

test("cards cut the same way twice share the axis as one row", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.5, 0.75, 1],
      ys: [0, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
        { id: "c", c0: 2, c1: 3, r0: 0, r1: 1 },
      ],
    },
    { width: W, height: H },
  );
  grid.balance();
  same(grid, ["a", "b", "c"], "w", "three columns");
});

test("a side cut the other way counts the row of it that holds the most cards", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.7, 0.8, 1],
      ys: [0, 0.6, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 2 },
        { id: "b", c0: 1, c1: 3, r0: 0, r1: 1 },
        { id: "c", c0: 1, c1: 2, r0: 1, r1: 2 },
        { id: "d", c0: 2, c1: 3, r0: 1, r1: 2 },
      ],
    },
    { width: W, height: H },
  );
  grid.balance();
  same(grid, ["a", "c", "d"], "w", "the finest row");
  near(grid.rect("b").w, grid.rect("c").w * 2 + grid.gap, "the card above spans both");
  same(grid, ["b", "c"], "h", "the right side halves");
});

test("a line that runs through both rows is a cut, and each side counts its fullest row", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.4, 0.7, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "b", c0: 1, c1: 3, r0: 0, r1: 1 },
        { id: "c", c0: 0, c1: 1, r0: 1, r1: 2 },
        { id: "d", c0: 1, c1: 2, r0: 1, r1: 2 },
        { id: "e", c0: 2, c1: 3, r0: 1, r1: 2 },
      ],
    },
    { width: W, height: H },
  );
  grid.balance();
  same(grid, ["a", "c", "d", "e"], "w", "the columns");
  near(grid.rect("b").w, grid.rect("d").w * 2 + grid.gap, "the upper right card spans two");
  assertTiling(grid, "after balance");
});

test("rows whose lines differ keep a line each", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.3, 0.5, 0.8, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "a", c0: 0, c1: 2, r0: 0, r1: 1 },
        { id: "b", c0: 2, c1: 4, r0: 0, r1: 1 },
        { id: "c", c0: 0, c1: 1, r0: 1, r1: 2 },
        { id: "d", c0: 1, c1: 3, r0: 1, r1: 2 },
        { id: "e", c0: 3, c1: 4, r0: 1, r1: 2 },
      ],
    },
    { width: W, height: H },
  );
  grid.balance();
  same(grid, ["a", "b"], "w", "the upper row");
  same(grid, ["c", "d", "e"], "w", "the lower row");
  assertTiling(grid, "after balance");
});

test("a card with a px size keeps it and the others share the rest", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.15, 0.3, 0.85, 1],
      ys: [0, 0.3, 1],
      cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 180, fixed: true },
        { id: "upper", c0: 1, c1: 3, r0: 0, r1: 1 },
        { id: "x", c0: 1, c1: 2, r0: 1, r1: 2 },
        { id: "y", c0: 2, c1: 3, r0: 1, r1: 2 },
        { id: "right", c0: 3, c1: 4, r0: 0, r1: 2, width: 200, fixed: true },
      ],
    },
    { width: W, height: H },
  );
  const left = grid.rect("left").w;
  const right = grid.rect("right").w;
  grid.balance();
  near(grid.rect("left").w, left, "the left sidebar");
  near(grid.rect("right").w, right, "the right sidebar");
  same(grid, ["x", "y"], "w", "the lower row");
  same(grid, ["upper", "x"], "h", "the rows");
  assertTiling(grid, "after balance");
});
