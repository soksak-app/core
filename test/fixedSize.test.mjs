import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, W, three } from "./helpers.mjs";

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
  assert.equal(left.w, 180, "the size it asked for, wherever it stands and whatever the gap");
  assert.equal(right.x + right.w, W, "the far one ends at the border");
  assert.equal(right.w, 200);

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
  assert.equal(rail.w, 190, "the same 190 as at an edge — the corridor is the plane's");
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
  assert.equal(grid.boundaryPos("x", 1), 260, "the boundary landed where it was dropped");
  assert.deepEqual(grid.lines("x"), linesBefore, "and the shared lines did not move");
  assert.equal(grid.rect("left").w, grid.card("left").width, "and the card draws the size it now holds");
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

test("dragging either edge of a fixed card resizes it, and the other edge holds", () => {
  const grid = edges();
  const before = { left: grid.rect("left"), right: grid.rect("right") };

  // the card's far edge — its start is fixed, so the size grows by the drag
  grid.moveBoundary("x", 1, before.left.x + before.left.w + grid.gap / 2 + 40);
  assert.equal(grid.card("left").width, 180 + 40, "the left sidebar grew by the drag");
  assert.equal(grid.rect("left").x, 0, "and stayed at the plane's border");

  // the card's near edge — its end is fixed, so dragging inward makes it wider
  const rightBefore = grid.rect("right");
  grid.moveBoundary("x", 2, rightBefore.x - grid.gap / 2 - 40);
  assert.equal(grid.card("right").width, 200 + 40, "the right sidebar grew by the drag");
  assert.equal(
    grid.rect("right").x + grid.rect("right").w,
    W,
    "and its far edge never left the plane's border",
  );
  assertTiling(grid, "after dragging both sidebars");
});

test("a boundary between two fixed cards belongs to the one before it", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.25, 0.5, 1],
      ys: [0, 1],
      cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 1, width: 190 },
        { id: "rail", c0: 1, c1: 2, r0: 0, r1: 1, width: 190 },
        { id: "main", c0: 2, c1: 3, r0: 0, r1: 1 },
      ],
    },
    { width: W, height: H },
  );
  const divider = grid.dividers().find((d) => d.axis === "x" && d.line === 1);
  assert.equal(divider.resizes, "left", "one rule picks it, so a drag is never a guess");

  grid.moveBoundary("x", 1, 230);
  assert.equal(grid.boundaryPos("x", 1), 230, "the card before took the change");
  assert.equal(grid.card("rail").width, 190, "the one after kept its size and moved along");
  assertTiling(grid, "between two fixed cards");
});

test("centring does nothing beside a fixed card — there is no half to compute", () => {
  const grid = edges();
  const before = grid.card("left").width;
  const at = grid.boundaryPos("x", 1);

  assert.equal(grid.centerBoundary("x", 1), at, "the boundary did not move");
  assert.equal(grid.card("left").width, before, "and the card kept the size it was given");

  // where both sides share, it still centres
  const shared = three();
  shared.moveBoundary("x", 1, 200);
  shared.centerBoundary("x", 1);
  assert.ok(
    Math.abs(shared.rect("sidebar").w - shared.rect("terminal").w) < 0.01,
    "two sharing cards still come out equal",
  );
});

test("a card inserted at a boundary is given a size, or it is not inserted", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 800 });
  grid.split("card", "x");

  for (const bad of [undefined, {}, { size: NaN }, { size: -40 }, { size: Infinity }]) {
    const before = grid.toJSON();
    assert.equal(grid.insertAt("x", 1, bad), null, `refused: ${JSON.stringify(bad)}`);
    assert.deepEqual(grid.toJSON(), before, "and nothing changed");
  }

  const id = grid.insertAt("x", 1, { id: "rail", size: 190 });
  assert.equal(id, "rail");
  assert.ok(Math.abs(grid.rect("rail").w - 190) < 0.01, `it draws 190, not ${grid.rect("rail").w}`);
  for (const [cid, r] of grid.rects()) {
    assert.ok(r.w > 0 && r.h > 0, `${cid} has area: ${JSON.stringify(r)}`);
  }
});

test("a role is declared, not written into the state", () => {
  const grid = three();
  assert.equal(Object.isFrozen(grid.card("sidebar")), true, "what came back is a report");
  assert.throws(() => { grid.card("sidebar").fixed = true; }, TypeError, "and writing to it throws");

  assert.equal(grid.setFixed("sidebar", true), true);
  assert.equal(grid.card("sidebar").fixed, true);
  assert.equal(grid.setFixed("nobody", true), false);

  assert.equal(grid.setSize("sidebar", "x", 240), true);
  assert.ok(Math.abs(grid.rect("sidebar").w - 240) < 0.01, "it draws what it was given");

  assert.equal(grid.setSize("sidebar", "x", -1), false, "a size is not negative");
  assert.equal(grid.setSize("sidebar", "x", NaN), false, "nor is it NaN");
  assert.equal(grid.card("sidebar").width, 240, "and a refusal changes nothing");

  assert.equal(grid.setSize("sidebar", "x", null), true, "it can go back to sharing");
  assert.equal(grid.card("sidebar").width, undefined);

  // with nothing left to share, a px size scales to cover the plane rather than
  // leaving the difference to no one
  const alone = new Soksak(undefined, { width: 1200, height: 800 });
  assert.equal(alone.setSize("card", "x", 200), true);
  assert.equal(alone.card("card").width, 200, "it still holds the number it was given");
  assert.ok(Math.abs(alone.rect("card").w - 1200) < 0.01, "and covers the plane exactly");
});
