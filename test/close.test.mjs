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
  // browser now spans both columns; the two panes above it only cover its
  // width together, which a single-neighbour rule would refuse
  const wide = grid.pane("browser");
  assert.equal(wide.c1 - wide.c0, 2, "it spans two columns");
  const fill = grid.fill(wide.id);
  assert.ok(fill, "it can still be closed");
  assert.equal(fill.panes.length, 2, "two neighbours share the job");
  const grown = fill.panes.map((p) => ({ id: p.id, before: grid.rect(p.id).h }));
  assert.equal(grid.close(wide.id), true);
  for (const g of grown) {
    assert.ok(grid.rect(g.id).h > g.before, `${g.id} did not grow`);
  }
  assertTiling(grid, "after a group fill");
});

test("closing keeps the arrangement slicing, which is what keeps panes closable", () => {
  const grid = three();
  fuzz(grid, 7, 200);
  assert.ok(grid.isSlicing());
  const open = grid.panes.filter((p) => !p.fixed);
  if (open.length > 1) {
    for (const pane of open) {
      assert.equal(grid.canClose(pane.id), true, `${pane.id} is stuck`);
    }
  }
});

test("any arrangement closes all the way down to a single pane", () => {
  for (let seed = 0; seed < 20; seed++) {
    const grid = three();
    for (let i = 0; i < 40; i++) {
      const open = grid.panes.filter((p) => !p.fixed);
      const pane = open[i % open.length];
      grid.split(pane.id, i % 2 ? "x" : "y");
    }
    const built = grid.panes.length;
    let closed = 0;
    for (;;) {
      const next = grid.panes.find((p) => !p.fixed && grid.canClose(p.id));
      if (!next) break;
      grid.close(next.id);
      closed++;
      assertTiling(grid, `seed ${seed} after ${closed} closes`);
    }
    assert.equal(
      grid.panes.filter((p) => !p.fixed).length,
      1,
      `seed ${seed}: built ${built}, stuck after ${closed} closes`,
    );
  }
});

test("the last remaining pane is kept", () => {
  const grid = make();
  assert.equal(grid.canClose(grid.panes[0].id), false);
  assert.equal(grid.close(grid.panes[0].id), false);
});

test("a fixed pane never fills a closed neighbour", () => {
  const grid = three();
  for (const pane of grid.panes) {
    const fill = grid.fill(pane.id);
    if (!fill) continue;
    assert.ok(
      fill.panes.every((p) => !p.fixed),
      "a fixed pane would spread over the plane",
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
  assert.notDeepEqual(vertical.toJSON().panes, horizontal.toJSON().panes);
  assertTiling(vertical, "vertical fill");
  assertTiling(horizontal, "horizontal fill");
});
