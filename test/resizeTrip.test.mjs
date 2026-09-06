import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";

test("a resize re-expresses the proportions and never rewrites them", () => {
  // Both axes declare a size, so a plane that cannot hold either one is the
  // scale at which a rewriting implementation has something to rewrite.
  const state = {
    xs: [0, 0.2, 0.6, 1],
    ys: [0, 0.3, 1],
    cards: [
      { id: "side", c0: 0, c1: 1, r0: 0, r1: 2, width: 190, fixed: true },
      { id: "head", c0: 1, c1: 2, r0: 0, r1: 1, height: 200 },
      { id: "body", c0: 1, c1: 2, r0: 1, r1: 2 },
      { id: "rail", c0: 2, c1: 3, r0: 0, r1: 2, width: 210, fixed: true },
    ],
  };
  const grid = new Soksak(state, { width: 900, height: 634, gap: 24, minSize: 96 });
  const was = [...grid.rects()];
  const xs = grid.lines("x"), ys = grid.lines("y");

  // Down to a plane that holds neither declared size, and back.
  grid.resize(110, 70);
  assert.ok([...grid.rects().values()].every((r) => r.w >= 0 && r.h >= 0), "no rect is inside out");
  grid.resize(900, 634);

  assert.deepEqual([...grid.rects()], was, "every card is drawn where it was");
  assert.deepEqual(grid.lines("x"), xs);
  assert.deepEqual(grid.lines("y"), ys);
  assert.equal(grid.card("side").width, 190, "and declares what it declared");
  assert.equal(grid.card("rail").width, 210);
  assert.equal(grid.card("head").height, 200);
});
