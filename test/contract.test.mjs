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

  // `browser` spans the line the split just made, so cardsCrossing has someone
  // to answer with. Without that the loop below skipped it.
  const crossing = grid.cardsCrossing("x", 2);
  assert.equal(crossing.length, 1, "a card spans the new line");
  for (const [what, got] of [
    ["cards", grid.cards[0]],
    ["card()", grid.card("terminal")],
    ["cardsCrossing", crossing[0]],
    ["fill().cards", grid.fill("terminal")?.cards[0]],
  ]) {
    assert.ok(got, `${what} answered`);
    assert.equal(Object.isFrozen(got), true, `${what} is frozen`);
  }

  // Writing to one changes nothing, whether it throws or is ignored.
  const rects = JSON.stringify([...grid.rects()]);
  for (const got of [grid.cards[0], grid.card("terminal"), ...crossing]) {
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

  // 축 이름이 아닌 것과 마찬가지로, 모드 이름이 아닌 것도 거절한다.
  const asked = new Soksak(undefined, { width: W, height: H, snap: "sideways" });
  assert.equal(asked.snap, "merge", "an unknown snap mode is refused");
  asked.snap = "off";
  assert.equal(asked.snap, "off", "a known one is taken");

  // 크기가 값이 아니면 판의 크기를 바꾸지 않는다. 바꾸면 모든 사각형이 NaN 이 된다.
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

test("the arguments each method reads are the ones it is given", () => {
  const grid = three();
  grid.split("terminal", "x", { id: "beside" });

  // isSlicing reads the list it is handed, not always its own.
  assert.equal(grid.isSlicing(), true);
  assert.equal(
    grid.isSlicing([
      { id: "a", c0: 0, c1: 2, r0: 0, r1: 1 },
      { id: "b", c0: 2, c1: 3, r0: 0, r1: 2 },
      { id: "c", c0: 1, c1: 3, r0: 2, r1: 3 },
      { id: "d", c0: 0, c1: 1, r0: 1, r1: 3 },
    ]),
    false,
    "a pinwheel handed in is answered for",
  );

  // standings honours `without`. `browser` spans the line the split just made,
  // so it blocks that boundary until it is the card being ignored.
  const crossed = grid.cardsCrossing("x", 2).map((c) => c.id);
  assert.deepEqual(crossed, ["browser"], "browser spans the new line");
  const all = grid.standings("x");
  const without = grid.standings("x", "browser");
  assert.ok(!all.includes(2), "so nothing may stand there");
  assert.ok(without.includes(2), "unless browser is the one being ignored");

  // canInsertAt checks the index, not only what crosses.
  for (const line of [-1, 1.5, NaN, 99]) {
    assert.equal(grid.canInsertAt("x", line), false, `line ${line}`);
  }

  // insertAt refuses a size the plane cannot hold.
  assert.equal(grid.insertAt("x", 1, { size: grid.width }), null, "the whole plane");
  assert.equal(grid.insertAt("x", 1, { size: grid.width + 1 }), null, "more than it");

  // mergeCoincident needs two lines at one coordinate, and refuses even then
  // while a card stands in the slot between them: folding would leave it with
  // no span at all.
  const lines = grid.lines("x").length;
  assert.equal(grid.mergeCoincident("x", 1), false, "these lines do not coincide");
  assert.equal(grid.lines("x").length, lines, "and nothing was folded");

  const thin = new Soksak(
    { xs: [0, 0.4, 0.4, 1], ys: [0, 1], cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "thin", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "b", c0: 2, c1: 3, r0: 0, r1: 1 },
    ] },
    { width: 1200, height: 600, gap: 24, minSize: 0 },
  );
  assert.equal(thin.lines("x")[1], thin.lines("x")[2], "two lines at one coordinate");
  assert.equal(thin.rect("thin").w, 0, "with a card between them");
  for (const line of [1, 2]) {
    assert.equal(thin.mergeCoincident("x", line), false, `folding at ${line} would lose thin`);
  }
  assert.equal(thin.lines("x").length, 4, "so both lines are still there");
  assert.ok(thin.card("thin"), "and the card is still there");
});

test("zoneAt returns nothing for a point that is not one", () => {
  const grid = three();
  for (const [x, y] of [[NaN, 10], [10, NaN], [Infinity, 10], [-1e9, -1e9]]) {
    assert.equal(grid.zoneAt(x, y), null, `${x},${y}`);
  }
  assert.ok(grid.zoneAt(grid.rect("terminal").x + 10, grid.rect("terminal").y + 10), "a real point lands");
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

test("checkState names every shape a state cannot have", () => {
  const base = { xs: [0, 0.5, 1], ys: [0, 1] };
  for (const [cards, why] of [
    [[{ c0: 0, c1: 1, r0: 0, r1: 1 }], /no id/],
    [[{ id: "", c0: 0, c1: 1, r0: 0, r1: 1 }], /no id/],
    [[{ id: 7, c0: 0, c1: 1, r0: 0, r1: 1 }], /no id/],
    [[{ id: "a", c0: 1, c1: 1, r0: 0, r1: 1 }], /not past/],
    [[{ id: "a", c0: 0, c1: 1, r0: 1, r1: 1 }], /not past/],
    [[{ id: "a", c0: 0.5, c1: 1, r0: 0, r1: 1 }], /not an index/],
  ]) {
    assert.throws(() => checkState({ ...base, cards }), why, JSON.stringify(cards));
  }
});

test("the options take every value that is one", () => {
  // Zero is a size, and the defaults are what the README states.
  const zero = new Soksak(undefined, { width: W, height: H, minSize: 0, gap: 0 });
  assert.equal(zero.minSize, 0, "a minimum of nothing is a minimum");
  assert.equal(zero.gap, 0);
  assert.ok(zero.split("card", "x"), "and nothing is too small to cut");

  const plain = new Soksak(undefined, { width: W, height: H });
  assert.deepEqual(
    [plain.gap, plain.minSize, plain.grabSize, plain.snapDistance, plain.snap, plain.fillOrder],
    [24, 96, 11, 7, "merge", "v"],
    "the defaults the README states",
  );
  const named = new Soksak(undefined, {
    width: W, height: H, gap: 8, minSize: 20, grabSize: 3, snapDistance: 2, snap: "off", fillOrder: "h",
  });
  assert.deepEqual(
    [named.gap, named.minSize, named.grabSize, named.snapDistance, named.snap, named.fillOrder],
    [8, 20, 3, 2, "off", "h"],
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
  grid.split("terminal", "x");
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

test("tidy drops every line no card reads, including the first", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 600, gap: 24, minSize: 0 });
  grid.split("card", "y");                       // two rows
  const spare = grid.split("card", "x");         // a line only the top row breaks on
  assert.ok(grid.close(spare), "closing it leaves the line behind");
  const virtual = grid.lines("x").findIndex((_, k) => grid.isVirtual("x", k));
  assert.equal(virtual, 1, "the line left over is the first interior one");
  assert.equal(grid.virtualCount(), 1);

  assert.equal(grid.tidy(), 1, "tidy takes it");
  assert.equal(grid.virtualCount(), 0, "and none is left");
  assert.equal(grid.lines("x").length, 2, "the array is one shorter");
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
        const n = grid.split(t, rnd() < 0.5 ? "x" : "y");
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
  const next = grid.split("card", "x", { id: "browser", data: { program: "browser" } });
  assert.equal(next, "browser");

  grid.replace({
    xs: [0, 0.25, 1],
    ys: [0, 1],
    cards: [
      { id: "terminal", c0: 0, c1: 1, r0: 0, r1: 1, data: { program: "terminal" } },
      { id: "browser", c0: 1, c1: 2, r0: 0, r1: 1, data: { program: "browser" } },
    ],
  });

  assert.equal(grid.card("card"), undefined);
  assert.equal(grid.card("terminal").data.program, "terminal");
  assert.deepEqual(grid.rect("browser"), { x: 312, y: 0, w: 888, h: 800 });
  // 판은 그대로이고 배치만 바뀌었다. 바뀌기 전의 카드는 이 배치에 없다.
  assert.equal(first.id, "card");
  assert.equal(grid.card(first.id), undefined, "the card that was replaced is gone");
});
