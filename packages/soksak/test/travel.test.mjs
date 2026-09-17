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
        { id: "upper", c0: 2, c1: 3, r0: 0, r1: 1 },
        { id: "lower", c0: 2, c1: 3, r0: 1, r1: 2 },
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
  grid.split("upper", "x");        // a line only the top row breaks on
  const blocked = grid.lines("x").length - 2;
  assert.equal(grid.canInsertAt("x", blocked), false, "lower spans it");
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

test("travelling between interior boundaries changes no other card's width", () => {
  const grid = railed();
  grid.split("upper", "x");
  grid.split("lower", "x");
  const before = Object.fromEntries(
    grid.cards.filter((c) => c.id !== "rail").map((c) => [c.id, grid.rect(c.id).w]),
  );

  const last = grid.lines("x").length - 1;
  const interior = grid.standings("x", "rail").filter((l) => l > 0 && l < last);
  assert.ok(interior.length > 1, "there is more than one boundary to travel between");
  for (const line of [...interior].reverse()) {
    assert.equal(grid.moveTo("rail", "x", line), true, `to ${line}`);
    for (const [id, w] of Object.entries(before)) {
      assert.equal(grid.rect(id).w, w, `${id} after the rail moved to ${line}`);
    }
    assert.equal(grid.rect("rail").w, 190, "and the rail kept its width");
    assertTiling(grid, `rail at ${line}`);
  }
});

test("standing on the plane's border moves the corridor, not the share", () => {
  const grid = railed();
  grid.split("upper", "x");
  grid.split("lower", "x");
  const xs = () => grid.lines("x");
  const share = (id) => {
    const c = grid.card(id);
    return xs()[c.c1] - xs()[c.c0];
  };
  const before = Object.fromEntries(
    grid.cards.filter((c) => c.id !== "rail").map((c) => [c.id, share(c.id)]),
  );
  const drawn = grid.rect("upper").w + grid.rect("card-1").w;
  assert.notEqual(grid.rect("upper").w, grid.rect("card-1").w, "card-1 is flush with the border");

  assert.equal(grid.moveTo("rail", "x", xs().length - 1), true);

  // Every column keeps the share it had. What changes is the corridor: the rail
  // pays half a gap at the border instead of a whole one, and the column that
  // was flush against the border now has the rail beside it.
  for (const [id, span] of Object.entries(before)) {
    assert.ok(Math.abs(share(id) - span) < 1e-9, `${id} kept its share`);
  }
  assert.equal(grid.rect("rail").w, 190);
  assert.ok(Math.abs(grid.rect("upper").w - grid.rect("card-1").w) < 1e-9,
            "equal shares now draw equal");
  assert.ok(Math.abs(grid.rect("upper").w + grid.rect("card-1").w - drawn) < 1e-9);
  assertTiling(grid, "rail on the border");
});

test("it lands on the boundary it was sent to", () => {
  // to the near boundary: only the left sidebar stands before it
  const near = railed();
  assert.equal(near.moveTo("rail", "x", 1), true);
  const nearRail = near.rect("rail");
  assert.ok(near.rect("left").x + near.rect("left").w < nearRail.x, "left is before it");
  assert.ok(near.rect("upper").x > nearRail.x, "the panes are after it");

  // to the far boundary: everything else stands before it
  const far = railed();
  assert.equal(far.moveTo("rail", "x", 3), true);
  const farRail = far.rect("rail");
  for (const id of ["left", "upper", "lower"]) {
    assert.ok(far.rect(id).x + far.rect(id).w <= farRail.x + 0.01, `${id} is before it`);
  }
  assertTiling(far, "landed at the far boundary");
});

test("a refused travel leaves the arrangement untouched", () => {
  const grid = railed();
  grid.split("upper", "x");
  const blocked = grid.lines("x").length - 2;
  const before = JSON.stringify(grid.toJSON());
  assert.equal(grid.moveTo("rail", "x", blocked), false, "a card spans it");
  assert.equal(JSON.stringify(grid.toJSON()), before);
});

test("a card that does not reach across cannot travel this way", () => {
  const grid = railed();
  assert.equal(grid.moveTo("upper", "x", 1), false, "it stands in one row only");
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

test("a travel that would leave a card with no area is refused", () => {
  // The slot leaves one boundary and arrives at another, so the pair that gives
  // the room and the pair that takes it are not the same. Found by fuzzing:
  // it happens about ten times in eighteen thousand states.
  const state = {
    xs: [0, 0.04997858047175793, 0.22326102321984956, 0.5145381395124059, 1],
    ys: [0, 0.5, 0.5, 1],
    cards: [
      { id: "left", c0: 1, c1: 2, r0: 0, r1: 3, fixed: true, width: 804.2623836009122 },
      { id: "middle", c0: 2, c1: 3, r0: 0, r1: 3, fixed: false, width: 233 },
      { id: "right", c0: 3, c1: 4, r0: 0, r1: 3, fixed: false },
      { id: "rail", c0: 0, c1: 1, r0: 0, r1: 3, fixed: false },
    ],
  };
  const grid = new Soksak(state, { width: 1117, height: 340, gap: 7, minSize: 47 });
  const before = JSON.stringify(grid.toJSON());
  const rects = JSON.stringify([...grid.rects()]);

  assert.equal(grid.moveTo("rail", "x", 2), false, "the travel is refused");
  assert.equal(JSON.stringify(grid.toJSON()), before, "and the arrangement is put back");
  assert.equal(JSON.stringify([...grid.rects()]), rects, "down to the rects");
  for (const [id, r] of grid.rects()) assert.ok(r.w > 0 && r.h > 0, `${id} still has area`);
});

test("canInsertAt refuses a line the axis does not have, and insertAt agrees", () => {
  // `standings` names the lines a rail could stand on and `insertAt` is what
  // takes one. A `canInsertAt` that answers for a line past the end reports a
  // boundary the plane does not have, and `insertAt` then refuses what it
  // promised.
  const grid = new Soksak(undefined, { width: W, height: H });
  grid.split("card", "x");
  const last = grid.lines("x").length - 1;
  assert.equal(grid.canInsertAt("x", last), true, "the far border is one of them");
  for (const line of [-1, last + 1, last + 2, 99]) {
    assert.equal(grid.canInsertAt("x", line), false, `${line} is not a line`);
    assert.equal(grid.insertAt("x", line, { size: 100 }), null, `${line} takes no card`);
  }
  assert.deepEqual(grid.standings("x"), [0, 1, 2], "and standings names only the lines there are");
});
