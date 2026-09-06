import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, fuzz, H, make, three, W } from "./helpers.mjs";

test("one matching neighbour takes the closed card's space", () => {
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

test("closing leaves a slicing arrangement", () => {
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
  const beside = grid.fill("terminal");
  assert.ok(beside, "a card beside the terminal can take its space");
  assert.ok(beside.cards.every((p) => p.id !== "sidebar"), "the sidebar was offered");
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

test("a card surrounded by fixed cards closes by removing its slots", () => {
  // rail on one side, a sidebar on the other — neither ever fills a gap
  const grid = new Soksak(
    {
      xs: [0, 0.2, 0.4, 0.7, 1],
      ys: [0, 1],
      cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 1, width: 180, fixed: true },
        { id: "main", c0: 1, c1: 2, r0: 0, r1: 1 },
        { id: "rail", c0: 2, c1: 3, r0: 0, r1: 1, width: 190, fixed: true },
        { id: "boxed", c0: 3, c1: 4, r0: 0, r1: 1 },
      ],
    },
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
    {
      xs: [0, 0.25, 0.5, 0.75, 1],
      ys: [0, 1],
      cards: [
        { id: "target", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "main", c0: 1, c1: 2, r0: 0, r1: 1 },
        { id: "rail", c0: 2, c1: 3, r0: 0, r1: 1, width: 190, fixed: true },
        { id: "boxed", c0: 3, c1: 4, r0: 0, r1: 1 },
      ],
    },
    { width: W, height: H },
  );
  assert.equal(grid.move("boxed", "target", "bottom"), true);
  assert.ok(grid.rect("boxed").y > grid.rect("target").y, "it landed under the target");
  assertTiling(grid, "after moving out from between fixed cards");
});

test("the last open card is not closed", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.3, 1],
      ys: [0, 1],
      cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 1, width: 180, fixed: true },
        { id: "only", c0: 1, c1: 2, r0: 0, r1: 1 },
      ],
    },
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
    { xs: [0, 1 / 3, 2 / 3, 1], ys: [0, 1], cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "c", c0: 2, c1: 3, r0: 0, r1: 1 },
    ] },
    { width: 451, height: 600, gap: 11, minSize: 51 },
  );
  const grid = make();
  const widths = (g) => g.cards.map((x) => `${x.id}:${g.rect(x.id).w.toFixed(4)}`).sort().join(" ");
  const was = widths(grid);
  assert.equal(grid.insertAt("x", 0, { size: 200, id: "rail" }), "rail");
  assert.equal(grid.close("rail"), true);
  assert.equal(widths(grid), was);
});

test("a card that arrives beside a run of coincident lines does not pull the run apart", () => {
  // Lines 2 and 3 stand at one place, so the slot between them has no width and
  // R5 gives it no corridor. Settling the rail in must not hand that slot a
  // corridor: a corridor is a size, a size is a span, and the run would come
  // apart and take one gap out of the cards beside it for good.
  const grid = new Soksak(
    {
      xs: [0, 0.375, 0.75, 0.75, 0.875, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "b", c0: 1, c1: 3, r0: 0, r1: 1 },
        { id: "c", c0: 3, c1: 4, r0: 0, r1: 1 },
        { id: "d", c0: 4, c1: 5, r0: 0, r1: 1 },
        { id: "e", c0: 0, c1: 2, r0: 1, r1: 2 },
        { id: "f", c0: 2, c1: 5, r0: 1, r1: 2 },
      ],
    },
    { width: 907, height: 1073, gap: 7, minSize: 77 },
  );
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w.toFixed(6)}`).sort().join(" ");
  const was = widths();

  assert.equal(grid.insertAt("x", 0, { size: 90, id: "rail" }), "rail");
  assert.equal(grid.close("rail"), true);

  assert.equal(widths(), was, "every card is back where it was");
  const xs = grid.lines("x");
  assert.equal(xs[2], xs[3], "and the two lines still stand at one place");
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
    {
      xs: [0, 0.3, 0.6, 0.8, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "A", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "A2", c0: 0, c1: 1, r0: 1, r1: 2 },
        { id: "B", c0: 1, c1: 2, r0: 0, r1: 2 },
        { id: "C", c0: 2, c1: 3, r0: 0, r1: 2 },
        { id: "rail", c0: 3, c1: 4, r0: 0, r1: 2, width: 150 },
      ],
      paidBy: { rail: { side: "hi", to: "A" } },   // as splitToward records it
    },
    { width: 1200, height: 800, gap: 20, minSize: 80 },
  );
  const width = (id) => grid.rect(id).w;
  const was = { A: width("A"), B: width("B"), C: width("C"), rail: width("rail") };
  // Re-proportioning divides, so the widths come back to within a rounding.
  const near = (id, w, note) =>
    assert.ok(Math.abs(width(id) - w) < 1e-9, `${id} is ${width(id)}, not ${w}: ${note}`);

  assert.equal(grid.close("rail"), true);
  near("A", was.A + was.rail + grid.gap, "A gave the room and A takes it back");
  near("B", was.B, "B is not the one that gave it");
  near("C", was.C, "nor is the neighbour the fill would have picked");
});

test("a card that arrives at a border takes its width from one slot, not a share from each", () => {
  // `b` reaches over two slots and `a` over one. The rail's width has to come
  // out of the sharing slots, and it must come out of one of them: a settle met
  // by scaling them all leaves no slot holding the room, and the close cannot
  // give it back.
  const grid = Soksak.from(
    {
      xs: [0, 0.25, 0.75, 1],
      ys: [0, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "b", c0: 1, c1: 3, r0: 0, r1: 1 },
      ],
    },
    { width: 600, height: 400, gap: 12, minSize: 60 },
  );
  const widths = () => grid.cards.map((c) => `${c.id}:${grid.rect(c.id).w.toFixed(6)}`).sort().join(" ");
  const was = widths();
  assert.equal(was, "a:144.000000 b:444.000000");

  assert.equal(grid.insertAt("x", 3, { size: 180, id: "rail" }), "rail");
  assert.equal(widths(), "a:144.000000 b:252.000000 rail:180.000000", "a is not beside it and does not pay");
  assert.equal(grid.close("rail"), true);
  assert.equal(widths(), was);
});
