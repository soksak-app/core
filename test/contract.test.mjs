import assert from "node:assert/strict";
import test from "node:test";

import { Soksak, checkState, outline } from "../dist/index.js";
import { H, W, three } from "./helpers.mjs";

/**
 * What the API hands back, and what it refuses.
 *
 * A host holds these values and acts on them, so a copy that turns out to be
 * the grid's own object, or a refusal that turns out to be a silent change, is
 * a defect the layout tests cannot see.
 */

test("everything the API hands back is a copy the host may keep", () => {
  const grid = three();
  grid.split("terminal", "x", { id: "editor", data: { pty: 3 } });

  for (const [what, got] of [
    ["cards", grid.cards[0]],
    ["card()", grid.card("terminal")],
    ["cardsCrossing", grid.cardsCrossing("x", 1)[0]],
    ["fill().cards", grid.fill("terminal")?.cards[0]],
  ]) {
    if (!got) continue;
    assert.equal(Object.isFrozen(got), true, `${what} is frozen`);
  }

  // Writing to one changes nothing, whether it throws or is ignored.
  const rects = JSON.stringify([...grid.rects()]);
  for (const got of [grid.cards[0], grid.card("terminal"), ...grid.cardsCrossing("x", 1)]) {
    try {
      got.r0 = 0;
      got.width = 9;
      got.fixed = true;
    } catch {
      /* frozen objects throw in strict mode, which is the same answer */
    }
  }
  assert.equal(JSON.stringify([...grid.rects()]), rects, "the plane is where it was");

  // Arrays are copies too: a host may sort or splice what it is given.
  const xs = grid.lines("x");
  xs[1] = 0.99;
  xs.push(2);
  assert.notDeepEqual(grid.lines("x"), xs, "lines() hands back a copy");

  const state = grid.toJSON();
  state.xs[1] = 0.99;
  state.cards.length = 0;
  assert.equal(grid.cards.length > 0, true, "toJSON hands back a copy");
  assert.notEqual(grid.lines("x")[1], 0.99);
});

test("an unknown id is answered, not thrown on, and changes nothing", () => {
  const grid = three();
  const before = JSON.stringify(grid.toJSON());

  assert.equal(grid.card("nobody"), undefined);
  assert.equal(grid.rect("nobody"), undefined);
  assert.equal(grid.fill("nobody"), null);
  assert.equal(grid.canClose("nobody"), false);
  assert.equal(grid.close("nobody"), false);
  assert.equal(grid.canSplit("nobody", "x"), false);
  assert.equal(grid.split("nobody", "x"), null);
  assert.equal(grid.splitToward("nobody", "left"), null);
  assert.equal(grid.setFixed("nobody", true), false);
  assert.equal(grid.setSize("nobody", "x", 100), false);
  assert.equal(grid.setData("nobody", { a: 1 }), false);
  assert.equal(grid.move("nobody", "terminal", "left"), false);
  assert.equal(grid.moveTo("nobody", "x", 1), false);
  assert.equal(grid.canMove("nobody", "terminal", "left"), false);

  assert.equal(JSON.stringify(grid.toJSON()), before, "and none of them changed anything");
});

test("a size a slot cannot hold is refused", () => {
  const grid = three();
  // A card spanning two slots has no px size to set: R5 defines the size as
  // one slot.
  const wide = grid.cards.find((c) => c.c1 - c.c0 > 1 || c.r1 - c.r0 > 1);
  assert.ok(wide, "the fixture has a card spanning more than one slot");
  const axis = wide.c1 - wide.c0 > 1 ? "x" : "y";
  assert.equal(grid.setSize(wide.id, axis, 100), false, `${wide.id} spans more than one slot`);
  assert.equal(grid.card(wide.id)[axis === "x" ? "width" : "height"], undefined);

  for (const bad of [-1, NaN, Infinity, -Infinity]) {
    assert.equal(grid.setSize("sidebar", "x", bad), false, String(bad));
  }
});

test("the options refuse a value that is not one, at construction and after", () => {
  for (const bad of [-1, NaN, Infinity]) {
    const grid = new Soksak(undefined, { width: W, height: H, gap: bad, minSize: bad });
    assert.equal(grid.gap, 24, `gap fell back from ${bad}`);
    assert.equal(grid.minSize, 96, `minSize fell back from ${bad}`);
  }

  const grid = new Soksak(undefined, { width: W, height: H });
  for (const bad of [-1, NaN, Infinity]) {
    grid.gap = bad;
    assert.equal(grid.gap, 24, `gap ignored ${bad}`);
  }
  grid.gap = 0;
  assert.equal(grid.gap, 0, "zero is a gap");
});

test("a boundary that is not one is refused, and a drag needs a number", () => {
  const grid = three();
  const last = grid.lines("x").length - 1;
  for (const line of [0, last, -1, 1.5, NaN, 99]) {
    assert.equal(grid.hasBoundary("x", line), false, `line ${line}`);
  }
  assert.equal(grid.hasBoundary("x", 1), true, "and a real one is");

  const before = [...grid.lines("x")];
  for (const px of [NaN, Infinity, -Infinity]) {
    grid.moveBoundary("x", 1, px);
    assert.deepEqual(grid.lines("x"), before, `a drag to ${px} moved nothing`);
  }
});

test("a zero gap is still grabbable", () => {
  // `grabSize` is kept apart from `gap` for this: with no corridor to aim at,
  // the hit area is what makes the boundary reachable.
  const grid = new Soksak(undefined, { width: W, height: H, gap: 0, grabSize: 11 });
  grid.split("card", "x");
  const [divider] = grid.dividers();
  assert.ok(divider, "there is somewhere to grab");
  assert.ok(divider.w >= 11, `the grab area is ${divider.w}px wide`);
  assert.equal(grid.rect("card").w + grid.rect("card-1").w, W, "and no corridor is drawn");
});

test("checkState applies the same rules as the constructor", () => {
  const good = { xs: [0, 0.5, 1], ys: [0, 1], cards: [
    { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
  ] };
  assert.doesNotThrow(() => checkState(good));

  const bad = { ...good, cards: [{ id: "a", c0: 0, c1: 9, r0: 0, r1: 1 }] };
  assert.throws(() => checkState(bad), /outside xs/);
  assert.throws(() => new Soksak(bad, { width: W, height: H }), /outside xs/);
});

test("outline returns a value for nothing, and for rects that do not meet", () => {
  assert.deepEqual(outline([]).loops, []);
  assert.equal(outline([]).path, "");
  assert.equal(outline([]).corners, 0);

  const apart = outline([
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 200, y: 0, w: 100, h: 100 },
  ], { pad: 10 });
  assert.equal(apart.loops.length, 2, "two loops when they do not meet");

  const meeting = outline([
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 120, y: 0, w: 100, h: 100 },
  ], { pad: 10 });
  assert.equal(meeting.loops.length, 1, "one when the padding closes the corridor");
});
