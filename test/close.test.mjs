import assert from "node:assert/strict";
import test from "node:test";

import { assertTiling, fuzz, make, three } from "./helpers.mjs";

test("a single matching neighbour takes the freed space", () => {
  const grid = three();
  const before = grid.rect("browser");
  assert.equal(grid.fill("terminal").side, "below");
  assert.equal(grid.close("terminal"), true);
  assert.ok(grid.rect("browser").h > before.h);
  assertTiling(grid, "after closing into one neighbour");
});

test("several neighbours tile the side together", () => {
  const grid = three();
  grid.split("terminal", "x");
  // browser now spans both columns; the two cards above it only cover its
  // width together, which a single-neighbour rule would refuse
  const wide = grid.card("browser");
  assert.equal(wide.c1 - wide.c0, 2, "it spans two columns");
  const fill = grid.fill(wide.id);
  assert.ok(fill, "it can still be closed");
  assert.equal(fill.cards.length, 2, "two neighbours share the job");
  const grown = fill.cards.map((p) => ({ id: p.id, before: grid.rect(p.id).h }));
  assert.equal(grid.close(wide.id), true);
  for (const g of grown) {
    assert.ok(grid.rect(g.id).h > g.before, `${g.id} did not grow`);
  }
  assertTiling(grid, "after a group fill");
});

test("closing keeps the arrangement slicing, which is what keeps cards closable", () => {
  const grid = three();
  fuzz(grid, 7, 200);
  assert.ok(grid.isSlicing());
  const open = grid.cards.filter((p) => !p.fixed);
  if (open.length > 1) {
    for (const card of open) {
      assert.equal(grid.canClose(card.id), true, `${card.id} is stuck`);
    }
  }
});

test("any arrangement closes all the way down to a single card", () => {
  for (let seed = 0; seed < 20; seed++) {
    const grid = three();
    for (let i = 0; i < 40; i++) {
      const open = grid.cards.filter((p) => !p.fixed);
      const card = open[i % open.length];
      grid.split(card.id, i % 2 ? "x" : "y");
    }
    const built = grid.cards.length;
    let closed = 0;
    for (;;) {
      const next = grid.cards.find((p) => !p.fixed && grid.canClose(p.id));
      if (!next) break;
      grid.close(next.id);
      closed++;
      assertTiling(grid, `seed ${seed} after ${closed} closes`);
    }
    assert.equal(
      grid.cards.filter((p) => !p.fixed).length,
      1,
      `seed ${seed}: built ${built}, stuck after ${closed} closes`,
    );
  }
});

test("the last remaining card is kept", () => {
  const grid = make();
  assert.equal(grid.canClose(grid.cards[0].id), false);
  assert.equal(grid.close(grid.cards[0].id), false);
});

test("a fixed card never fills a closed neighbour", () => {
  const grid = three();
  for (const card of grid.cards) {
    const fill = grid.fill(card.id);
    if (!fill) continue;
    assert.ok(
      fill.cards.every((p) => !p.fixed),
      "a fixed card would spread over the plane",
    );
  }
});

test("fillOrder picks the axis when both sides could take the space", () => {
  const build = (fillOrder) => {
    const grid = three({ fillOrder });
    grid.split("terminal", "x");
    grid.split("browser", "x");
    return grid;
  };
  const vertical = build("v");
  const horizontal = build("h");
  assert.equal(vertical.fill("terminal").side, "below");
  assert.equal(horizontal.fill("terminal").side, "right");

  vertical.close("terminal");
  horizontal.close("terminal");
  assert.notDeepEqual(vertical.toJSON().cards, horizontal.toJSON().cards);
  assertTiling(vertical, "vertical fill");
  assertTiling(horizontal, "horizontal fill");
});
