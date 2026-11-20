import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, fuzz, H, make, three, trySplit, W } from "./helpers.mjs";

test("the other kid of a cut takes the whole cut when a card closes", () => {
  const grid = three();
  const before = grid.rect("lower");
  assert.equal(grid.canClose("upper"), true);
  assert.equal(grid.close("upper"), true);
  assert.equal(grid.rect("lower").h, H, "lower spans the plane that the cut held");
  assert.equal(grid.rect("lower").w, before.w, "and keeps its width");
  assertTiling(grid, "after closing into the only other kid");
});

test("a cut left with one kid is replaced by that kid, which keeps its own cut", () => {
  const grid = three();
  grid.split("upper", "x");
  // lower now spans both columns and is a kid of a cut along y whose other kid is a cut along x
  const wide = grid.card("lower");
  assert.equal(wide.c1 - wide.c0, 2, "it spans two columns");
  const grown = grid.cards
    .filter((p) => p.id !== wide.id && !p.fixed)
    .map((p) => ({ id: p.id, before: grid.rect(p.id).h }));
  assert.equal(grown.length, 2);
  assert.equal(grid.canClose(wide.id), true);
  assert.equal(grid.close(wide.id), true);
  for (const g of grown) {
    assert.equal(grid.rect(g.id).h, H, `${g.id} did not take the whole height`);
  }
  assertTiling(grid, "after the cut was replaced by its other kid");
});

test("cards can be closed down to the last one", () => {
  for (let seed = 0; seed < 20; seed++) {
    const grid = three();
    for (let i = 0; i < 40; i++) {
      const open = grid.cards.filter((p) => !p.fixed);
      const card = open[i % open.length];
      trySplit(grid, card.id, i % 2 ? "x" : "y");
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

test("the last card is not closed", () => {
  const grid = make();
  assert.equal(grid.canClose(grid.cards[0].id), false);
  assert.equal(grid.close(grid.cards[0].id), false);
});

test("a fixed card is not closed", () => {
  const grid = three();
  assert.equal(grid.card("sidebar").fixed, true);
  assert.equal(grid.canClose("sidebar"), false);
  assert.equal(grid.close("sidebar"), false);
  assert.ok(grid.card("sidebar"), "the card is still there");
  grid.setFixed("sidebar", false);
  assert.equal(grid.canClose("sidebar"), true, "it can close the moment the fixing is lifted");
});

test("a card surrounded by fixed cards closes and the sharing card takes its space", () => {
  // rail on one side, a sidebar on the other: neither takes space from a close
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.2, node: { card: "left", fixed: true, width: 180 } }, { share: 0.2, node: { card: "main" } }, { share: 0.29999999999999993, node: { card: "rail", fixed: true, width: 190 } }, { share: 0.30000000000000004, node: { card: "boxed" } }] } },
    { width: W, height: H },
  );
  assert.equal(grid.canClose("boxed"), true);

  const mainBefore = grid.rect("main").w;
  assert.equal(grid.close("boxed"), true);
  assert.equal(grid.card("boxed"), undefined);
  assert.equal(grid.card("left").width, 180, "the fixed cards kept their size");
  assert.equal(grid.card("rail").width, 190);
  assert.ok(grid.rect("main").w > mainBefore, "the sharing card took the room back");
  assertTiling(grid, "after the slot went");
});

test("a card that cannot close can still be moved", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.25, node: { card: "target" } }, { share: 0.25, node: { card: "main" } }, { share: 0.25, node: { card: "rail", fixed: true, width: 190 } }, { share: 0.25, node: { card: "boxed" } }] } },
    { width: W, height: H },
  );
  assert.equal(grid.move("boxed", "target", "bottom"), true);
  assert.ok(grid.rect("boxed").y > grid.rect("target").y, "it landed under the target");
  assertTiling(grid, "after moving out from between fixed cards");
});

test("the last open card is not closed", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.3, node: { card: "left", fixed: true, width: 180 } }, { share: 0.7, node: { card: "only" } }] } },
    { width: W, height: H },
  );
  assert.equal(grid.canClose("only"), false);
  assert.equal(grid.close("only"), false);
});

test("a state restored from toJSON closes like the original", () => {
  const grid = new Soksak(undefined, { width: 1600, height: 1000, gap: 24, minSize: 96 });
  grid.splitToward("card", "left", { id: "n2" });
  grid.split("n2", "x", { id: "n3" });
  const widths = (g) => g.cards.map((c) => `${c.id}:${g.rect(c.id).w.toFixed(3)}`).join(" ");

  const copy = Soksak.from(grid.toJSON(), { width: 1600, height: 1000, gap: 24, minSize: 96 });
  assert.equal(widths(copy), widths(grid), "the same rects");

  grid.close("n3");
  copy.close("n3");
  assert.equal(widths(copy), widths(grid), "and the same close");
});

test("a refused move leaves nothing behind", () => {
  const start = () => {
    const grid = new Soksak(undefined, { width: 600, height: 200, gap: 24, minSize: 96 });
    grid.setSize("card", "x", 155);
    grid.insertAt("x", 1, { size: 181, id: "n3" });
    grid.insertAt("x", 1, { size: 141, id: "n4" });
    return grid;
  };
  const plain = start();
  const tried = start();
  // The halves of the 200 px column above and below `card` would be 88 px, below `minSize`.
  assert.equal(tried.move("n3", "card", "top"), false, "the move is refused");
  assert.deepEqual(tried.toJSON(), plain.toJSON(), "and changes no state");

  plain.close("n3");
  tried.close("n3");
  assert.deepEqual(tried.toJSON(), plain.toJSON(), "so the next close does the same thing");
});

test("closing a card every slot paid for gives the span back to every slot", () => {
  // A card wider than either slot beside it cannot take its span from one of
  // them: every slot is scaled to make room. Closing it inverts that scale, so
  // the plane is drawn as it was before the card arrived.
  const grid = new Soksak(undefined, { width: 616, height: 500, gap: 2, minSize: 20 });
  const other = grid.split("card", "x");
  const was = [grid.rect("card").w, grid.rect(other).w];
  assert.equal(grid.insertAt("x", 2, { id: "rail", size: 466 }), "rail");
  assert.equal(grid.close("rail"), true);
  const now = [grid.rect("card").w, grid.rect(other).w];
  assert.ok(
    Math.abs(now[0] - was[0]) < 0.01 && Math.abs(now[1] - was[1]) < 0.01,
    `${now} after the rail left, ${was} before it arrived`,
  );
});

test("a card that arrives takes its width from the kid before the line, and a close shares it among every kid", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "card" } }, { share: 0.25, node: { card: "n1" } }, { share: 0.25, node: { card: "n2" } }] } },
    { width: 800, height: 600, gap: 24, minSize: 96 },
  );
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w.toFixed(3)}`).sort().join(" ");
  assert.equal(widths(), "card:376.000 n1:188.000 n2:188.000");

  // The kids hold no px size and two fractions, so the kid before the line alone pays the width and the corridor.
  assert.equal(grid.insertAt("x", 1, { size: 200, id: "rail" }), "rail");
  assert.equal(widths(), "card:152.000 n1:188.000 n2:188.000 rail:200.000", "only the kid before the line paid");

  // The close scales the other kids by one factor, so their shares keep their ratios.
  const shares = () => grid.toJSON().root.kids.map((kid) => kid.share);
  const [card, , n1, n2] = shares();
  assert.equal(grid.close("rail"), true);
  const [a, b, c] = shares();
  const factor = a / card;
  assert.ok(Math.abs(b / n1 - factor) < 1e-9 && Math.abs(c / n2 - factor) < 1e-9, "every kid scaled by one factor");
  assert.equal(widths(), "card:216.485 n1:267.758 n2:267.758");
});

test("a rail at the plane's border returns the span every slot gave it", () => {
  // No slot beside the border has 200px to give, so every slot gives a share.
  // Closing must return it the same way; the border is not a line to remove, so
  // the far one is.
  const make = () => new Soksak(
    { root: { cut: "x", kids: [{ share: 0.3333333333333333, node: { card: "a" } }, { share: 0.3333333333333333, node: { card: "b" } }, { share: 0.33333333333333337, node: { card: "c" } }] } },
    { width: 451, height: 600, gap: 11, minSize: 51 },
  );
  const grid = make();
  const widths = (g) => g.cards.map((x) => `${x.id}:${g.rect(x.id).w.toFixed(4)}`).sort().join(" ");
  const was = widths(grid);
  assert.equal(grid.insertAt("x", 0, { size: 200, id: "rail" }), "rail");
  assert.equal(grid.close("rail"), true);
  assert.equal(widths(grid), was);
});

test("a card that arrives at the border of a nested cut and leaves gives every card its width back", () => {
  // The rail takes its width from a, which stands in a cut inside the first kid of the root. The close gives the span
  // back to that kid, a takes it, and b keeps the width it had inside the same cut.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.75, node: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "b" } }] } }, { share: 0.5, node: { card: "e" } }] } }, { share: 0.25, node: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "c" } }, { share: 0.5, node: { card: "d" } }] } }, { share: 0.5, node: { card: "f" } }] } }] } },
    { width: 907, height: 1073, gap: 7, minSize: 77 },
  );
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w.toFixed(6)}`).sort().join(" ");
  const was = widths();

  assert.equal(grid.insertAt("x", 0, { size: 90, id: "rail" }), "rail");
  assert.equal(grid.close("rail"), true);

  assert.equal(widths(), was, "every card is back where it was");
});

test("a slot standing at zero width takes the corridor it will hold once it is given one", () => {
  // The rail at the far edge takes its span from every kid, which leaves the
  // slot of the rail standing at zero width while the settle runs. The width it
  // is named at is the width it had, so the corridor to add is the one it will
  // hold again, not the nothing a slot with no width holds.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "card" } }, { share: 0.25, node: { card: "n1" } }, { share: 0.25, node: { card: "n2" } }] } },
    { width: 800, height: 600, gap: 8, minSize: 60 },
  );
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w.toFixed(6)}`).sort().join(" ");
  const was = widths();
  assert.equal(was, "card:392.000000 n1:196.000000 n2:196.000000");

  // n1 alone would have to give 208 px at the boundary before n2 and holds 196, so the line is refused.
  assert.equal(grid.insertAt("x", 2, { size: 200, id: "rail" }), null);
  assert.equal(widths(), was, "and nothing changed");

  // At the edge every kid gives in proportion to its fraction, so the three keep the ratio 2, 1, 1.
  assert.equal(grid.insertAt("x", 3, { size: 200, id: "rail" }), "rail");
  assert.equal(
    widths(),
    "card:288.000000 n1:144.000000 n2:144.000000 rail:200.000000",
    "the 208 px of the rail and its corridor come from the three in the ratio 2, 1, 1",
  );
  assert.equal(grid.close("rail"), true);
  assert.equal(widths(), was);
});

test("a card that arrives at a border takes a share from every kid in proportion", () => {
  // The rail arrives at the far border beside `b`, and `a` is not beside it. At the
  // edge of the plane every kid gives in proportion to its fraction, so `a` pays too and
  // the two keep the ratio 1 to 3.
  const grid = Soksak.from(
    { root: { cut: "x", kids: [{ share: 0.25, node: { card: "a" } }, { share: 0.75, node: { card: "b" } }] } },
    { width: 600, height: 400, gap: 12, minSize: 60 },
  );
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w.toFixed(6)}`).sort().join(" ");
  const was = widths();
  assert.equal(was, "a:147.000000 b:441.000000");

  // The lines are 0, 1/4 and 1, so the far border is line 2.
  assert.equal(grid.insertAt("x", 2, { size: 180, id: "rail" }), "rail");
  // The 192 px of the rail and its corridor come from the two in the ratio 1 to 3.
  assert.equal(widths(), "a:99.000000 b:297.000000 rail:180.000000", "a pays in proportion to its share");
  assert.equal(grid.close("rail"), true);
  assert.equal(widths(), was, "the close scales the shares back by one factor");
});

test("a card whose neighbours are all fixed gives its space to the other cards in proportion", () => {
  // The rail's two neighbours are fixed, so no kid of its cut can fill the space.
  // Every other kid of the cut takes a share of it in proportion to its share, and
  // the fixed cards keep their declared sizes.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.2, node: { card: "one" } }, { share: 0.2, node: { card: "two" } }, { share: 0.19999999999999996, node: { card: "left", fixed: true, width: 200 } }, { share: 0.20000000000000007, node: { card: "rail", width: 190 } }, { share: 0.19999999999999996, node: { card: "right", fixed: true, width: 180 } }] } },
    { width: 1600, height: 600, gap: 24 },
  );
  const one = grid.rect("one").w;
  const two = grid.rect("two").w;
  const rail = grid.rect("rail").w;

  assert.equal(grid.close("rail"), true, "no neighbour can fill, so every other kid takes a share");
  assert.equal(grid.rect("one").w, one + (rail + grid.gap) / 2, "one takes half of the space and the corridor");
  assert.equal(grid.rect("two").w, two + (rail + grid.gap) / 2, "two takes the other half");
  assert.equal(grid.rect("left").w, 200, "the declared sizes are untouched");
  assert.equal(grid.rect("right").w, 180);
  assertTiling(grid, "after the rail's slot went");
});

test("a close after a split gives the span to the other kids of the cut in proportion", () => {
  // The cut is uneven, so the split takes the fraction of the new card from `top` alone. The
  // close scales the fractions of the other kids by one factor, so `top` and `bottom` keep the
  // ratio they had when the close began and `bottom` takes its part of the span as well.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { cut: "y", kids: [{ share: 0.6, node: { card: "top" } }, { share: 0.4, node: { card: "bottom" } }] } }, { share: 0.5, node: { card: "right" } }] } },
    { width: 1000, height: 400, gap: 20, minSize: 40 },
  );
  const tall = (id) => Number(grid.rect(id).h.toFixed(2));
  const shares = () => grid.toJSON().root.kids[0].node.kids.map((kid) => kid.share);
  assert.deepEqual([tall("top"), tall("bottom")], [228, 152]);

  for (let round = 0; round < 2; round++) {
    const born = grid.split("top", "y", { id: `mid${round}` });
    assert.equal(born, `mid${round}`, `round ${round}: the cut was refused`);
    if (round === 0) {
      assert.deepEqual(shares(), [0.3, 0.3, 0.4], "the cut halves the fraction of top and leaves the fraction of bottom alone");
      assert.deepEqual([tall("top"), tall(born), tall("bottom")], [108, 108, 144], "each fraction of the 360 px after the corridors");
    }
    const [top, , bottom] = shares();
    assert.equal(grid.close(born), true);
    const [a, b] = shares();
    assert.ok(Math.abs(a / top - b / bottom) < 1e-9, `round ${round}: top and bottom kept their ratio`);
    if (round === 0) {
      assert.deepEqual([tall("top"), tall("bottom")], [162.86, 217.14], "the span went to both");
    }
    assertTiling(grid, `after round ${round}`);
  }
});

test("a close and a move give the space to the other kid of the card's own cut", () => {
  // a and c are the kids of one cut along y, and b stands on the right of a across
  // the cut along x, so b never takes the space of a.
  const quarters = () => new Soksak({ root: { cut: "x", kids: [{ share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "c" } }] } }, { share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "b" } }, { share: 0.5, node: { card: "d" } }] } }] } }, { width: W, height: H });
  const grid = quarters();
  assert.equal(grid.close("a"), true);
  assert.equal(grid.cards.length, 3);
  assert.deepEqual([grid.card("b").c0, grid.card("c").r0, grid.card("c").r1], [1, 0, 2], "c spans the cut and b stays beside it");
  assertTiling(grid, "after the close");
  // A move closes the card the same way, then lands it beside the target.
  const moving = quarters();
  assert.equal(moving.move("a", "c", "right"), true);
  assert.deepEqual([moving.card("b").c0, moving.card("c").r0, moving.card("a").c0], [2, 0, moving.card("c").c1]);
  assertTiling(moving, "after a move that closed the card");
});

test("a close scales the other kids of its cut by one factor", () => {
  // REMOVE: the kids that stay keep their ratios, so neither neighbour alone takes the space.
  const grid = new Soksak({ root: { cut: "x", kids: [{ share: 0.2, node: { card: "a" } }, { share: 0.3, node: { card: "b" } }, { share: 0.5, node: { card: "c" } }] } }, { width: 1000, height: 600, gap: 0, minSize: 20 });
  assert.equal(grid.close("b"), true);
  const ratio = grid.rect("c").w / grid.rect("a").w;
  assert.ok(Math.abs(ratio - 2.5) < 1e-9, `c is ${ratio} times a, not 2.5`);
  assert.ok(Math.abs(grid.rect("a").w - 1000 * 0.2 / 0.7) < 1e-6, `a is ${grid.rect("a").w}`);
});

test("a close keeps the size of a kid that holds a fixed card", () => {
  const grid = new Soksak({ root: { cut: "x", kids: [{ share: 0.2, node: { card: "f", fixed: true } }, { share: 0.3, node: { card: "a" } }, { share: 0.2, node: { card: "b" } }, { share: 0.3, node: { card: "c" } }] } }, { width: 1000, height: 600, gap: 0, minSize: 20 });
  assert.equal(grid.close("a"), true);
  assert.ok(Math.abs(grid.rect("f").w - 200) < 1e-6, `f is ${grid.rect("f").w}, not 200`);
  assert.ok(Math.abs(grid.rect("c").w / grid.rect("b").w - 1.5) < 1e-9, "b and c keep their ratio");
});

test("a state names no payer", () => {
  const grid = new Soksak(undefined, { width: 1000, height: 600 });
  grid.split("card", "x");
  assert.deepEqual(Object.keys(grid.toJSON()), ["root"]);
  assert.throws(() => new Soksak({ root: { card: "a" }, paidBy: {} }), /the state holds paidBy, which the layout does not record; the state is \{root\}/);
});

test("a close gives a share to a sibling cut that holds a fixed card", () => {
  const grid = new Soksak({ root: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.2, node: { card: "f", fixed: true, width: 200 } }, { share: 0.8, node: { card: "a" } }] } }, { share: 0.5, node: { card: "b" } }] } }, { width: 1000, height: 600, gap: 0, minSize: 20 });
  assert.equal(grid.canClose("b"), true);
  assert.equal(grid.close("b"), true);
  assert.equal(grid.rect("a").h, 600);
  assert.equal(grid.rect("f").w, 200);
});

test("a withdraw that leaves only fixed cards in its cut is refused, and the fixed cards keep their fractions", () => {
  const state = { root: { cut: "y", kids: [
    { share: 0.5, node: { cut: "x", kids: [{ share: 0.4, node: { card: "a" } }, { share: 0.3, node: { card: "f1", fixed: true } }, { share: 0.3, node: { card: "f2", fixed: true } }] } },
    { share: 0.5, node: { card: "b" } },
  ] } };
  const grid = new Soksak(state, { width: 1000, height: 600, gap: 24, minSize: 96 });
  const before = JSON.stringify(grid.toJSON());
  assert.throws(() => grid.withdraw("a"), /card a leaves no card of its cut that takes its space/);
  assert.equal(JSON.stringify(grid.toJSON()), before, "a refusal changes nothing");
});
