import assert from "node:assert/strict";
import test from "node:test";

import { Soksak, checkState, outline } from "../dist/index.js";
import { H, W, three, trySplit } from "./helpers.mjs";

/**
 * What the API hands back, and what it refuses.
 *
 * A host holds these values and acts on them, so a copy that turns out to be
 * the grid's own object, or a refusal that turns out to be a silent change, is
 * a defect the layout tests cannot see.
 */

test("everything the API hands back is a copy the host may keep", () => {
  const grid = three();
  grid.split("upper", "x", { id: "writer", data: { pty: 3 } });

  // `lower` spans the line the split just made, so cardsCrossing has someone
  // to answer with. Without that the loop below skipped it.
  const crossing = grid.cardsCrossing("x", 2);
  assert.equal(crossing.length, 1, "a card spans the new line");
  for (const [what, got] of [
    ["cards", grid.cards[0]],
    ["card()", grid.card("upper")],
    ["cardsCrossing", crossing[0]],
  ]) {
    assert.ok(got, `${what} answered`);
    assert.equal(Object.isFrozen(got), true, `${what} is frozen`);
  }

  // Writing to one changes nothing, whether it throws or is ignored.
  const rects = JSON.stringify([...grid.rects()]);
  for (const got of [grid.cards[0], grid.card("upper"), ...crossing]) {
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
  state.root.kids[0].share = 0.99;
  state.root.kids.length = 0;
  assert.equal(grid.cards.length, 4, "toJSON hands back a copy");
  assert.notEqual(grid.lines("x")[1], 0.99);
});

test("an unknown id is answered, a split throws it, and nothing changes", () => {
  const grid = three();
  const before = JSON.stringify(grid.toJSON());

  assert.equal(grid.card("nobody"), undefined);
  assert.equal(grid.rect("nobody"), undefined);
  assert.equal(grid.canClose("nobody"), false);
  assert.equal(grid.close("nobody"), false);
  assert.equal(grid.canSplit("nobody", "x"), false);
  assert.throws(() => grid.split("nobody", "x"), { message: "card nobody is not a member of the layout" });
  assert.throws(() => grid.splitToward("nobody", "left"), { message: "card nobody is not a member of the layout" });
  assert.equal(grid.setFixed("nobody", true), false);
  assert.equal(grid.setSize("nobody", "x", 100), false);
  assert.equal(grid.setData("nobody", { a: 1 }), false);
  assert.equal(grid.move("nobody", "upper", "left"), false);
  assert.equal(grid.moveTo("nobody", "x", 1), false);
  assert.equal(grid.canMove("nobody", "upper", "left"), false);

  assert.equal(JSON.stringify(grid.toJSON()), before, "and none of them changed anything");
});

test("a size that is no size is refused, and a card spanning two slots takes one", () => {
  const grid = three();
  // A px size belongs to the card of the tree (R5), so a card that spans the
  // cells of another cut takes one.
  const wide = grid.cards.find((c) => c.c1 - c.c0 > 1 || c.r1 - c.r0 > 1);
  assert.ok(wide, "the fixture has a card spanning more than one slot");
  const axis = wide.c1 - wide.c0 > 1 ? "x" : "y";
  assert.equal(grid.setSize(wide.id, axis, 100), true, `${wide.id} spans more than one slot`);
  assert.equal(grid.card(wide.id)[axis === "x" ? "width" : "height"], 100);

  for (const bad of [-1, NaN, Infinity, -Infinity]) {
    assert.equal(grid.setSize("sidebar", "x", bad), false, String(bad));
  }
});

test("the options refuse a value that is not one, at construction and after", () => {
  for (const bad of [-1, NaN, Infinity]) {
    const grid = new Soksak(undefined, {
      width: bad, height: bad, gap: bad, minSize: bad,
      grabSize: bad, snapDistance: bad,
    });
    assert.equal(grid.gap, 24, `gap fell back from ${bad}`);
    assert.equal(grid.minSize, 96, `minSize fell back from ${bad}`);
    assert.equal(grid.grabSize, 11, `grabSize fell back from ${bad}`);
    assert.equal(grid.snapDistance, 7, `snapDistance fell back from ${bad}`);
    assert.equal(grid.width, 0, `width fell back from ${bad}`);
    assert.equal(grid.height, 0, `height fell back from ${bad}`);
  }

  // Like a value that is not an axis name, a value that is not a mode name is also rejected.
  const asked = new Soksak(undefined, { width: W, height: H, snap: "sideways" });
  assert.equal(asked.snap, "merge", "an unknown snap mode is refused");
  asked.snap = "off";
  assert.equal(asked.snap, "off", "a known one is taken");

  // A size that is not a number does not change the size of the board. Otherwise every rectangle becomes NaN.
  const sized = new Soksak(undefined, { width: W, height: H });
  sized.resize(NaN, H);
  assert.equal(sized.width, W, "resize kept the width");
  assert.ok(Number.isFinite(sized.rect("card").w), "the card still has a width");

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
  const good = { root: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "b" } }] } };
  assert.doesNotThrow(() => checkState(good));

  const bad = { root: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.4, node: { card: "b" } }] } };
  assert.throws(() => checkState(bad), /not canonical: its shares sum to 0\.9/);
  assert.throws(() => new Soksak(bad, { width: W, height: H }), /not canonical: its shares sum to 0\.9/);
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

test("the arguments each method reads are the ones it is given", () => {
  const grid = three();
  grid.split("upper", "x", { id: "beside" });

  // standings names the seams of the root and the edges of the plane. `lower`
  // spans the line the split just made, which is no seam of the root.
  const crossed = grid.cardsCrossing("x", 2).map((c) => c.id);
  assert.deepEqual(crossed, ["lower"], "lower spans the new line");
  assert.ok(!grid.standings("x").includes(2), "so nothing may stand there");
  assert.equal(grid.canInsertAt("x", 2), false);

  // canInsertAt checks the index, not only what crosses.
  for (const line of [-1, 1.5, NaN, 99]) {
    assert.equal(grid.canInsertAt("x", line), false, `line ${line}`);
  }

  // insertAt refuses a size the plane cannot hold.
  assert.equal(grid.insertAt("x", 1, { size: grid.width }), null, "the whole plane");
  assert.equal(grid.insertAt("x", 1, { size: grid.width + 1 }), null, "more than it");

});

test("zoneAt returns nothing for a point that is not one", () => {
  const grid = three();
  for (const [x, y] of [[NaN, 10], [10, NaN], [Infinity, 10], [-1e9, -1e9]]) {
    assert.equal(grid.zoneAt(x, y), null, `${x},${y}`);
  }
  assert.ok(grid.zoneAt(grid.rect("upper").x + 10, grid.rect("upper").y + 10), "a real point lands");
});

test("outline's radius follows pad, and it reports its corners", () => {
  const one = outline([{ x: 0, y: 0, w: 200, h: 200 }], { pad: 16 });
  assert.equal(one.corners, 4, "a rect has four");
  assert.equal(one.sharp, 0);
  // The default radius is `pad` itself, so a padded rect is drawn flush with a
  // square card. A pad below any floor is what shows that: at 16 a default of
  // `max(4, pad)` looks the same.
  const arcs = (shape) => [...shape.path.matchAll(/A([\d.]+) /g)].map((m) => Number(m[1]));
  assert.deepEqual(arcs(one), [16, 16, 16, 16]);
  assert.deepEqual(
    arcs(outline([{ x: 0, y: 0, w: 200, h: 200 }], { pad: 2 })),
    [2, 2, 2, 2],
    "a small pad gives a small radius",
  );

  assert.deepEqual(
    arcs(outline([{ x: 0, y: 0, w: 200, h: 200 }], { pad: 16, radius: 40 })),
    [40, 40, 40, 40],
    "and a named radius wins",
  );
});

test("the options take every value that is one", () => {
  // Zero is a size, and the defaults are what the layout specification states.
  const zero = new Soksak(undefined, { width: W, height: H, minSize: 0, gap: 0 });
  assert.equal(zero.minSize, 0, "a minimum of nothing is a minimum");
  assert.equal(zero.gap, 0);
  assert.ok(zero.split("card", "x"), "and nothing is too small to cut");

  const plain = new Soksak(undefined, { width: W, height: H });
  assert.deepEqual(
    [plain.gap, plain.minSize, plain.grabSize, plain.snapDistance, plain.snap],
    [24, 96, 11, 7, "merge"],
    "the defaults the layout specification states",
  );
  const named = new Soksak(undefined, {
    width: W, height: H, gap: 8, minSize: 20, grabSize: 3, snapDistance: 2, snap: "off",
  });
  assert.deepEqual(
    [named.gap, named.minSize, named.grabSize, named.snapDistance, named.snap],
    [8, 20, 3, 2, "off"],
    "and a named value is kept",
  );
});

test("a boundary at the plane's edge returns px, not nothing", () => {
  const grid = three();
  // The borders have no line beyond them, so the range falls back to the plane
  // itself. A missing fallback reads as `null` and every comparison against it
  // then returns a wrong value.
  for (const axis of ["x", "y"]) {
    for (const line of [0, grid.lines(axis).length - 1]) {
      const [min, max] = grid.boundaryRange(axis, line);
      assert.equal(typeof min, "number", `${axis}${line} min`);
      assert.equal(typeof max, "number", `${axis}${line} max`);
      assert.ok(min >= 0 && max <= (axis === "x" ? W : H), `${axis}${line} is inside the plane`);
    }
  }
});

test("centring the plane's border changes nothing, and centring a boundary halves it", () => {
  const grid = three();
  grid.split("upper", "x");
  for (const axis of ["x", "y"]) {
    const last = grid.lines(axis).length - 1;
    const before = [...grid.lines(axis)];
    // A border is not a boundary. Centring one answers where it is and moves
    // no line.
    for (const line of [0, last]) {
      const at = grid.centerBoundary(axis, line);
      assert.equal(at, grid.boundaryPos(axis, line), `${axis}${line} answered ${at}`);
      assert.deepEqual(grid.lines(axis), before, `${axis}${line} moved a line`);
    }
  }

  // An interior boundary is centred between the two lines beside it, so the two
  // cards it separates come out the same width.
  const wide = new Soksak(undefined, { width: 1200, height: 800, gap: 0, minSize: 0 });
  wide.split("card", "x");
  wide.moveBoundary("x", 1, 900);
  assert.equal(wide.centerBoundary("x", 1), 600, "centred between the borders");
  assert.equal(wide.rect("card").w, wide.rect("card-1").w, "and the two are equal");
});

test("a card cannot be inserted at the size of the plane or more", () => {
  // Without the check `openSlot` writes a line before the plane starts and the
  // array comes back out of order and past 1. It takes a plane that has been
  // worked on to reach, so this walks a fixed set of them.
  let inserted = 0;
  let refused = 0;
  for (let seed = 0; seed < 60; seed++) {
    const grid = new Soksak(undefined, {
      width: 100 + (seed % 1400),
      height: 100 + (seed % 900),
      gap: seed % 40,
      minSize: seed % 120,
    });
    const ids = ["card"];
    let r = seed * 7919 + 3;
    const rnd = () => {
      r = (r * 1103515245 + 12345) >>> 0;
      return r / 4294967296;
    };
    for (let i = 0; i < 12; i++) {
      const t = ids[Math.floor(rnd() * ids.length)];
      const k = rnd();
      if (k < 0.5) {
        const n = trySplit(grid, t, rnd() < 0.5 ? "x" : "y");
        if (n) ids.push(n);
      } else if (k < 0.7) {
        grid.setSize(t, rnd() < 0.5 ? "x" : "y", 20 + Math.floor(rnd() * 300));
      } else {
        grid.moveBoundary(rnd() < 0.5 ? "x" : "y", 1, rnd() * grid.width);
      }

      for (const axis of ["x", "y"]) {
        const plane = axis === "x" ? grid.width : grid.height;
        for (const line of [0, 1, grid.lines(axis).length - 1]) {
          const got = grid.insertAt(axis, line, { size: plane });
          if (got === null) refused++;
          else inserted++;
          const along = grid.lines(axis);
          for (let k2 = 1; k2 < along.length; k2++) {
            assert.ok(along[k2] >= along[k2 - 1], `seed ${seed}: ${axis} out of order: ${along.join(", ")}`);
          }
          assert.ok(along.every((v) => v >= 0 && v <= 1), `seed ${seed}: ${axis} outside 0..1`);
        }
      }
    }
  }
  assert.equal(inserted, 0, "no plane took a card as wide as itself");
  assert.ok(refused > 1000, `and the sweep reached ${refused} of them`);

  // The check refuses only what it names: a plane with the room still takes one.
  const grid = new Soksak(undefined, { width: 1200, height: 800, gap: 24, minSize: 0 });
  grid.split("card", "x");
  assert.ok(grid.insertAt("x", 0, { size: 40, id: "narrow" }), "a size the plane holds");
});

test("replace updates the canonical arrangement without replacing the grid", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 800, minSize: 0 });
  const first = grid.card("card");
  const next = grid.split("card", "x", { id: "lower", data: { program: "lower" } });
  assert.equal(next, "lower");

  grid.replace({ root: { cut: "x", kids: [{ share: 0.25, node: { card: "upper", data: { program: "upper" } } }, { share: 0.75, node: { card: "lower", data: { program: "lower" } } }] } });

  assert.equal(grid.card("card"), undefined);
  assert.equal(grid.card("upper").data.program, "upper");
  assert.deepEqual(grid.rect("lower"), { x: 318, y: 0, w: 882, h: 800 });
  // The board is the same and only the arrangement changed. The card before the change is not in this arrangement.
  assert.equal(first.id, "card");
  assert.equal(grid.card(first.id), undefined, "the card that was replaced is gone");
});
