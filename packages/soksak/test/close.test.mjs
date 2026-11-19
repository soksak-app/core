import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, fuzz, H, make, three, W } from "./helpers.mjs";

test("one matching neighbour takes the closed card's space", () => {
  const grid = three();
  const before = grid.rect("lower");
  assert.equal(grid.fill("upper").side, "below");
  assert.equal(grid.close("upper"), true);
  assert.ok(grid.rect("lower").h > before.h);
  assertTiling(grid, "after closing into one neighbour");
});

test("several neighbours tile the side together", () => {
  const grid = three();
  grid.split("upper", "x");
  // lower now spans both columns; the two cards above it only cover its
  // width together, which a single-neighbour rule would refuse
  const wide = grid.card("lower");
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

test("cards can be closed down to the last one", () => {
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

test("the last card is not closed", () => {
  const grid = make();
  assert.equal(grid.canClose(grid.cards[0].id), false);
  assert.equal(grid.close(grid.cards[0].id), false);
});

test("a fixed card does not fill", () => {
  const grid = three();
  let answered = 0;
  for (const card of grid.cards) {
    const fill = grid.fill(card.id);
    if (!fill) continue;
    answered++;
    assert.ok(
      fill.cards.every((p) => !p.fixed),
      "a fixed card would spread over the plane",
    );
  }
  // Without this a build whose fill always returns null passes on an empty loop.
  assert.ok(answered > 0, "and some card had a filler to check");

  // The sidebar is fixed and beside the panes, so it is the one that must not
  // be offered as a filler.
  assert.equal(grid.card("sidebar").fixed, true);
  const beside = grid.fill("upper");
  assert.ok(beside, "a card beside the upper card can take its space");
  assert.ok(beside.cards.every((p) => p.id !== "sidebar"), "the sidebar was offered");

  // And a fixed card is never the one filled. Its two neighbours tile its side
  // and would grow over any other card there, so the answer comes from `fixed`
  // rather than from the arrangement.
  assert.equal(grid.fill("sidebar"), null, "no neighbour takes a fixed card's space");
  grid.setFixed("sidebar", false);
  assert.ok(grid.fill("sidebar"), "and they take it the moment that is lifted");
});

test("fillOrder does not pick a neighbour across the cut", () => {
  const build = (fillOrder) => {
    const grid = three({ fillOrder });
    grid.split("upper", "x");
    grid.split("lower", "x");
    return grid;
  };
  const vertical = build("v");
  const horizontal = build("h");
  // upper is a kid of a cut along x, so lower below it is no kid of that cut and never takes its space.
  assert.equal(vertical.fill("upper").side, "right");
  assert.equal(horizontal.fill("upper").side, "right");

  vertical.close("upper");
  horizontal.close("upper");
  assert.deepEqual(vertical.toJSON(), horizontal.toJSON());
  assertTiling(vertical, "vertical fill");
  assertTiling(horizontal, "horizontal fill");
});

test("a card surrounded by fixed cards closes by removing its slots", () => {
  // rail on one side, a sidebar on the other — neither ever fills a gap
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.2, node: { card: "left", fixed: true, width: 180 } }, { share: 0.2, node: { card: "main" } }, { share: 0.29999999999999993, node: { card: "rail", fixed: true, width: 190 } }, { share: 0.30000000000000004, node: { card: "boxed" } }] } },
    { width: W, height: H },
  );
  assert.equal(grid.fill("boxed"), null, "no neighbour can grow into it");
  assert.equal(grid.canClose("boxed"), true, "but it can still leave");

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

test("the room goes back to the slot that gave it, not the nearest one", () => {
  // The slot beside the boundary may be unable to give the room without
  // falling under minSize, so a further one pays. Closing must find that one.
  const start = () => {
    const grid = new Soksak(undefined, { width: 1600, height: 1000, gap: 24, minSize: 96 });
    grid.split("card", "y", { id: "n1" });
    grid.split("card", "y", { id: "n2" });
    return grid;
  };
  const heights = (grid) => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).h.toFixed(3)}`).join(" ");

  for (const line of [0, 1, 2, 3]) {
    const grid = start();
    const was = heights(grid);
    const id = grid.insertAt("y", line, { size: 150 });
    assert.ok(id, `inserted at ${line}`);
    // card is 238 tall, so it cannot give 174 and stay above 96: n1 pays.
    assert.equal(grid.close(id), true);
    assert.equal(heights(grid), was, `line ${line}`);
  }
});

test("the state carries where each slot came from", () => {
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
    const grid = new Soksak(undefined, { width: 1600, height: 1000, gap: 24, minSize: 96 });
    grid.setSize("card", "x", 155);
    grid.insertAt("y", 1, { size: 181, id: "n3" });
    grid.insertAt("y", 1, { size: 141, id: "n4" });
    return grid;
  };
  const plain = start();
  const tried = start();
  assert.equal(tried.move("n3", "card", "left"), false, "the move is refused");
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

test("a card that arrives takes its width from one slot, and gives it back to that one", () => {
  const grid = new Soksak(undefined, { width: 800, height: 600, gap: 24, minSize: 96 });
  grid.split("card", "x", { id: "n1" });
  grid.split("n1", "x", { id: "n2" });
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w}`).sort().join(" ");
  const was = widths();
  assert.equal(was, "card:388 n1:176 n2:188");

  assert.equal(grid.insertAt("x", 1, { size: 200, id: "rail" }), "rail");
  assert.equal(widths(), "card:164 n1:176 n2:188 rail:200", "only the slot beside it paid");
  assert.equal(grid.close("rail"), true);
  assert.equal(widths(), was, "and it is the one that got it back");
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
  // The rail's slot takes its span from the slot beside it, which leaves that
  // slot standing at zero width while the settle runs. The width it is named at
  // is the width it had, so the corridor to add is the one it will hold again —
  // not the nothing a slot with no width holds.
  const grid = new Soksak(undefined, { width: 800, height: 600, gap: 8, minSize: 60 });
  grid.split("card", "x", { id: "n1" });
  grid.split("n1", "x", { id: "n2" });
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w.toFixed(6)}`).sort().join(" ");
  const was = widths();
  assert.equal(was, "card:396.000000 n1:192.000000 n2:196.000000");

  assert.equal(grid.insertAt("x", 2, { size: 200, id: "rail" }), "rail");
  assert.equal(grid.close("rail"), true);
  assert.equal(widths(), was);
});

test("a card at the far border returns its room to the slot it came from", () => {
  // The recorded side is where the width came from, and here it is two slots
  // along. Removing the line on that side is not possible at the plane's border,
  // so the other line comes off instead. Without that the whole path is skipped
  // and the fill hands the room to whichever neighbour it picks.
  const grid = Soksak.from(
    { root: { cut: "x", kids: [{ share: 0.3, node: { cut: "y", kids: [{ share: 0.5, node: { card: "A" } }, { share: 0.5, node: { card: "A2" } }] } }, { share: 0.3, node: { card: "B" } }, { share: 0.20000000000000007, node: { card: "C" } }, { share: 0.19999999999999996, node: { card: "rail", width: 150 } }] }, paidBy: { rail: "A" } },
    { width: 1200, height: 800, gap: 20, minSize: 80 },
  );
  const width = (id) => grid.rect(id).w;
  const was = { A: width("A"), B: width("B"), C: width("C"), rail: width("rail") };
  // Re-proportioning divides, so the widths come back to within a rounding.
  const near = (id, w, note) =>
    assert.ok(Math.abs(width(id) - w) < 1e-9, `${id} is ${width(id)}, not ${w}: ${note}`);

  assert.equal(grid.close("rail"), true);
  // The line comes off, which is what returning the span means: skipping the
  // path leaves it standing and a neighbour grows over the slot instead.
  assert.equal(grid.lines("x").length, 4, "the rail's line went with it");
  near("A", was.A + was.rail + grid.gap, "A gave the room and A takes it back");
  near("B", was.B, "B is not the one that gave it");
  near("C", was.C, "nor is the neighbour the fill would have picked");
});

test("a card that arrives at a border takes its width from one slot, not a share from each", () => {
  // The rail arrives at the far border beside `b`, and `a` is not beside it. The
  // rail's width has to come out of the sharing slots, and it must come out of
  // one of them: a settle met by scaling them all leaves no slot holding the room,
  // and the close cannot give it back.
  const grid = Soksak.from(
    { root: { cut: "x", kids: [{ share: 0.25, node: { card: "a" } }, { share: 0.75, node: { card: "b" } }] } },
    { width: 600, height: 400, gap: 12, minSize: 60 },
  );
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w.toFixed(6)}`).sort().join(" ");
  const was = widths();
  assert.equal(was, "a:144.000000 b:444.000000");

  // The lines are 0, 1/4 and 1, so the far border is line 2.
  assert.equal(grid.insertAt("x", 2, { size: 180, id: "rail" }), "rail");
  assert.equal(widths(), "a:144.000000 b:252.000000 rail:180.000000", "a is not beside it and does not pay");
  assert.equal(grid.close("rail"), true);
  assert.equal(widths(), was);
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

test("a close gives the width to the neighbour beside it when no kid of its cut holds the payer", () => {
  // `paidBy` records that n took its width from r, and r is a kid of the root, not of the cut that holds n. No kid of
  // that cut can give the width back, so the neighbour that the fill order names takes it and p keeps its width.
  const grid = Soksak.from(
    { root: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.25, node: { card: "p" } }, { share: 0.25, node: { card: "n" } }, { share: 0.5, node: { card: "q" } }] } }, { share: 0.5, node: { card: "r" } }] }, paidBy: { n: "r" } },
    { width: 1000, height: 600, gap: 20 },
  );
  const wide = (id) => grid.rect(id).w;
  assert.deepEqual(["p", "n", "q", "r"].map(wide), [240, 230, 490, 1000]);

  assert.equal(grid.close("n"), true);
  assert.deepEqual(["p", "q", "r"].map(wide), [240, 740, 1000], "q took the width of n and its corridor");
});

test("a split and the close after it are inverses when a neighbour grows over the slot", () => {
  // `paidBy` records the card a split cut the new one out of, so the close hands
  // the width back to it. Where the closing card's line cannot be removed —
  // another card reads it — a row of neighbours grows over the slot instead, and
  // the width went to whichever neighbour that was: `top` lost half its height
  // to `bottom` on every split-and-close pair, until it was too short to cut.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "top" } }, { share: 0.5, node: { card: "bottom" } }] } }, { share: 0.5, node: { card: "right" } }] } },
    { width: 1000, height: 400, gap: 20, minSize: 40 },
  );
  const tall = (id) => Number(grid.rect(id).h.toFixed(2));
  assert.deepEqual([tall("top"), tall("bottom")], [190, 190]);

  for (let round = 0; round < 3; round++) {
    const born = grid.split("top", "y", { id: `mid${round}` });
    assert.equal(born, `mid${round}`, `round ${round}: the cut was refused`);
    assert.deepEqual(
      [tall("top"), tall(born), tall("bottom")],
      [90, 80, 190],
      `round ${round}: the cut divides top and leaves bottom alone`,
    );
    // `right` reads the line the cut made, so the close cannot take that line
    // away: the row below grows over the slot instead.
    assert.equal(grid.fill(born).side, "below", `round ${round}: bottom fills the slot`);
    assert.equal(grid.close(born), true);
    assert.deepEqual(
      [tall("top"), tall("bottom")],
      [190, 190],
      `round ${round}: the width went back to the card the cut took it from`,
    );
    assertTiling(grid, `after round ${round}`);
  }
});

test("a close and a move give the space to a kid of the card's own cut", () => {
  // a and c are the kids of one cut along y, and b stands on the right of a across
  // the cut along x, so b never takes the space of a.
  const quarters = () => new Soksak({ root: { cut: "x", kids: [{ share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "c" } }] } }, { share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "b" } }, { share: 0.5, node: { card: "d" } }] } }] } }, { width: W, height: H });
  const grid = quarters();
  assert.deepEqual(grid.fillSides, ["below", "above", "right", "left"]);
  assert.equal(grid.fill("a").side, "below");
  assert.equal(grid.fill("a", ["right", "below"]).side, "below");
  assert.equal(grid.fill("a", ["left"]), null);
  assert.equal(grid.close("a", ["right", "below"]), true);
  assert.deepEqual([grid.card("b").c0, grid.card("c").r0], [1, 0]);
  assertTiling(grid, "after closing into the named side");
  // No named side: c, the other kid of the cut, takes the space in proportion.
  const kept = quarters();
  assert.equal(kept.close("a", []), true);
  assert.equal(kept.cards.length, 3);
  // A move closes the card the same way, then lands it beside the target.
  const moving = quarters();
  assert.equal(moving.move("a", "c", "right", ["right"]), true);
  assert.deepEqual([moving.card("b").c0, moving.card("c").r0, moving.card("a").c0], [2, 0, moving.card("c").c1]);
  assertTiling(moving, "after a move that closed into the named side");
  assert.throws(() => quarters().close("a", ["middle"]), { message: "unknown fill side middle" });
});

// close and move check the sides at the boundary before they act, as fill does and as the Go port does: a fixed card, the last card, a
// card with a paidBy record and a missing card refuse another side with its name rather than answering (layout.md, the API table).
test("close and move refuse another side before they judge the card", () => {
  const quarters = () => new Soksak({ root: { cut: "x", kids: [{ share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "c" } }] } }, { share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "b" } }, { share: 0.5, node: { card: "d" } }] } }] } }, { width: W, height: H });
  const fixed = quarters();
  fixed.setFixed("a", true);
  assert.throws(() => fixed.close("a", ["up"]), { message: "unknown fill side up" });
  assert.throws(() => fixed.move("a", "c", "right", ["up"]), { message: "unknown fill side up" });
  const last = new Soksak();
  const only = last.cards[0].id;
  assert.throws(() => last.close(only, ["up"]), { message: "unknown fill side up" });
  const paid = quarters();
  const born = paid.splitToward("a", "right");
  assert.ok(Object.hasOwn(paid.toJSON().paidBy, born), "the split card holds a paidBy record");
  assert.throws(() => paid.close(born, ["up"]), { message: "unknown fill side up" });
  assert.throws(() => quarters().close("missing", ["up"]), { message: "unknown fill side up" });
  assert.throws(() => quarters().move("missing", "c", "right", ["up"]), { message: "unknown fill side up" });
});

test("a kid of the root whose payer no kid holds gives its space to the kid after it", () => {
  // `paidBy` names a card that no longer stands in the plane, so no kid of the root can take the space back. The kid
  // after the rail takes it, and the kid before it keeps its width.
  const grid = Soksak.from(
    { root: { cut: "x", kids: [{ share: 0.4, node: { card: "p" } }, { share: 0.2, node: { card: "rail" } }, { share: 0.4, node: { card: "q" } }] }, paidBy: { rail: "gone" } },
    { width: 1000, height: 600, gap: 20 },
  );
  const wide = (id) => Number(grid.rect(id).w.toFixed(6));
  assert.deepEqual(["p", "rail", "q"].map(wide), [390, 180, 390]);
  assert.equal(grid.close("rail"), true);
  assert.deepEqual(["p", "q"].map(wide), [390, 590], "q took the width of the rail and its corridor");
});
