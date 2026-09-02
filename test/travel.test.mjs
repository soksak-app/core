import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, W } from "./helpers.mjs";

/**
 * A rail is a card that reaches across the plane. It can only stand where no
 * card spans over the boundary, and travelling is a column leaving and a column
 * arriving — never a close and a split, because those rearrange everything else.
 */
const railed = () =>
  new Soksak(
    {
      xs: [0, 0.2, 0.35, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 180, fixed: true },
        { id: "rail", c0: 1, c1: 2, r0: 0, r1: 2, width: 190, fixed: true },
        { id: "terminal", c0: 2, c1: 3, r0: 0, r1: 1 },
        { id: "browser", c0: 2, c1: 3, r0: 1, r1: 2 },
      ],
    },
    { width: W, height: H },
  );

test("a rail reaches across the plane, whatever is beside it", () => {
  const grid = railed();
  assert.equal(grid.rect("rail").h, H);
  assertTiling(grid, "a rail standing");
});

test("it can only stand where nothing spans the boundary", () => {
  const grid = railed();
  grid.split("terminal", "x");        // a line only the top row breaks on
  const blocked = grid.lines("x").length - 2;
  assert.equal(grid.canInsertAt("x", blocked), false, "browser spans it");
  assert.ok(grid.standings("x").length > 0, "and the full-height ones remain");
  assert.ok(!grid.standings("x").includes(blocked));
});

test("travelling changes no other card's spans and no row boundary", () => {
  const grid = railed();
  const rowsBefore = grid.lines("y");
  const spansBefore = Object.fromEntries(
    grid.cards.filter((c) => c.id !== "rail").map((c) => [c.id, [c.r0, c.r1]]),
  );
  const heightsBefore = Object.fromEntries(
    grid.cards.filter((c) => c.id !== "rail").map((c) => [c.id, grid.rect(c.id).h]),
  );

  assert.equal(grid.moveTo("rail", "x", 3), true, "to the far boundary");

  assert.deepEqual(grid.lines("y"), rowsBefore, "no horizontal line moved");
  for (const [id, span] of Object.entries(spansBefore)) {
    assert.deepEqual([grid.card(id).r0, grid.card(id).r1], span, `${id} kept its rows`);
    assert.equal(grid.rect(id).h, heightsBefore[id], `${id} kept its height`);
  }
  assert.equal(grid.card("rail").width, 190, "and the rail kept its width");
  assert.equal(grid.rect("rail").h, H, "and still reaches across");
  assertTiling(grid, "after travelling");
});

test("it lands on the boundary it was sent to", () => {
  // to the near boundary: only the left sidebar stands before it
  const near = railed();
  assert.equal(near.moveTo("rail", "x", 1), true);
  const nearRail = near.rect("rail");
  assert.ok(near.rect("left").x + near.rect("left").w < nearRail.x, "left is before it");
  assert.ok(near.rect("terminal").x > nearRail.x, "the panes are after it");

  // to the far boundary: everything else stands before it
  const far = railed();
  assert.equal(far.moveTo("rail", "x", 3), true);
  const farRail = far.rect("rail");
  for (const id of ["left", "terminal", "browser"]) {
    assert.ok(far.rect(id).x + far.rect(id).w <= farRail.x + 0.01, `${id} is before it`);
  }
  assertTiling(far, "landed at the far boundary");
});

test("a refused travel leaves the arrangement untouched", () => {
  const grid = railed();
  grid.split("terminal", "x");
  const blocked = grid.lines("x").length - 2;
  const before = JSON.stringify(grid.toJSON());
  assert.equal(grid.moveTo("rail", "x", blocked), false, "a card spans it");
  assert.equal(JSON.stringify(grid.toJSON()), before);
});

test("a card that does not reach across cannot travel this way", () => {
  const grid = railed();
  assert.equal(grid.moveTo("terminal", "x", 1), false, "it stands in one row only");
});

test("standing still is success and changes nothing", () => {
  const grid = railed();
  const before = JSON.stringify(grid.toJSON());
  assert.equal(grid.moveTo("rail", "x", 1), true);
  assert.equal(JSON.stringify(grid.toJSON()), before);
});

test("standings includes the plane's borders", () => {
  // insertAt accepts index 0 and the last index, so standings must list them.
  const grid = new Soksak(undefined, { width: 1200, height: 600 });
  assert.deepEqual(grid.standings("x"), [0, 1], "a single card leaves both borders free");

  const left = new Soksak(undefined, { width: 1200, height: 600 });
  assert.equal(left.insertAt("x", 0, { id: "rail", size: 190 }), "rail");
  assert.equal(left.rect("rail").x, 0, "index 0 places it at the near border");

  const right = new Soksak(undefined, { width: 1200, height: 600 });
  assert.equal(right.insertAt("x", 1, { id: "rail", size: 190 }), "rail");
  assert.ok(
    Math.abs(right.rect("rail").x + right.rect("rail").w - 1200) < 0.01,
    "the last index places it at the far border",
  );
});
