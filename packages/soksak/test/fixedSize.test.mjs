import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, W, three } from "./helpers.mjs";

/** Lines are drawn from the fractions that a drag stores, so a position or a size is the one asked for within their rounding. */
const near = (actual, expected, note) => assert.ok(Math.abs(actual - expected) < 1e-9, `${note}: ${actual}, not ${expected}`);

/**
 * A sidebar is a card. So is a rail. What makes them what they are is which slot
 * they hold and that they hold it at a fixed width — there is no second kind of
 * object, and nothing to keep in step with the cards.
 */
const edges = (options = {}) =>
  new Soksak(
    { root: { cut: "x", kids: [{ share: 0.3333333333333333, node: { card: "left", fixed: true, width: 180 } }, { share: 0.3333333333333333, node: { cut: "y", kids: [{ share: 0.5, node: { card: "upper" } }, { share: 0.5, node: { card: "lower" } }] } }, { share: 0.33333333333333337, node: { card: "right", fixed: true, width: 200 } }] } },
    { width: W, height: H, ...options },
  );

test("a slot with a px size takes it; the rest share what is left", () => {
  const grid = edges();
  const left = grid.rect("left");
  const right = grid.rect("right");
  const upper = grid.rect("upper");

  assert.equal(left.x, 0, "it starts at the plane's border");
  assert.equal(left.w, 180, "the size it asked for, wherever it stands and whatever the gap");
  assert.equal(right.x + right.w, W, "the far one ends at the border");
  assert.equal(right.w, 200);

  assert.equal(upper.x - (left.x + left.w), grid.gap, "one full corridor, like any two cards");
  assert.equal(right.x - (upper.x + upper.w), grid.gap);
  assertTiling(grid, "with two fixed cards");
});

test("a card in a middle slot spans the plane and nothing crosses it", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "upper" } }, { share: 0.5, node: { card: "lower" } }] } }, { share: 0.25, node: { card: "rail", fixed: true, width: 190 } }, { share: 0.25, node: { card: "writer" } }] } },
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

test("resizing the plane changes the sharing cards", () => {
  const grid = edges();
  const before = { left: grid.rect("left").w, right: grid.rect("right").w, mid: grid.rect("upper").w };
  grid.resize(W + 400, H);
  const after = { left: grid.rect("left").w, right: grid.rect("right").w, mid: grid.rect("upper").w };

  assert.equal(after.left, before.left, "a fixed width is fixed");
  assert.equal(after.right, before.right);
  assert.equal(after.mid, before.mid + 400, "the sharing card took the whole change");
});

test("dragging the boundary beside a px slot resizes it", () => {
  const grid = edges();
  // A divider is a place to grab a line; it does not announce whose size it
  // changes. What the drag does is the thing to check.
  const linesBefore = [...grid.lines("x")];
  grid.moveBoundary("x", 1, 260);
  near(grid.boundaryPos("x", 1), 260, "the boundary landed where it was dropped");
  assert.deepEqual(grid.lines("x").slice(2), linesBefore.slice(2), "and the shared lines did not move");
  assert.equal(grid.rect("left").w, grid.card("left").width, "and the card draws the size it now holds");
  assertTiling(grid, "after resizing the sidebar");
});

test("a card too narrow for two cannot be cut on that axis", () => {
  const grid = edges();
  // 180 cannot hold the minimum 96 of two cards and the 24 gap between them. This is not caused by the px size.
  // With that size, a wide card is also cut off, as the 400px card below shows.
  assert.equal(grid.card("left").width, 180);
  assert.equal(grid.canSplit("left", "x"), false, "180 < 96 + 24 + 96");
});

test("splitting across the other axis keeps the px size on both halves", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.4, node: { card: "side", width: 180 } }, { share: 0.6, node: { card: "main" } }] } },
    { width: W, height: H },
  );
  const born = grid.split("side", "y");
  assert.ok(born, "a fixed width does not stop a cut across it");
  assert.equal(grid.card(born).width, 180, "both halves still stand in that slot");
  assert.equal(grid.rect("side").w, grid.rect(born).w);
  assertTiling(grid, "after splitting a fixed-width card");
});

test("move keeps the card's px size", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.25, node: { card: "rail", width: 190 } }, { share: 0.75, node: { cut: "y", kids: [{ share: 0.5, node: { card: "upper" } }, { share: 0.5, node: { card: "lower" } }] } }] } },
    { width: W, height: H },
  );
  assert.equal(grid.move("rail", "lower", "right"), true, "a rail is repositioned by move");
  assert.equal(grid.card("rail").width, 190, "and arrives the size it left");
  assert.ok(grid.rect("rail").x > grid.rect("lower").x, "on the side it was sent to");
  assertTiling(grid, "after the rail travelled");
});

test("dragging either edge of a px slot resizes it and holds the other edge", () => {
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

test("a boundary between two px slots changes both and nothing else", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.25, node: { card: "left", width: 190 } }, { share: 0.25, node: { card: "rail", width: 190 } }, { share: 0.5, node: { card: "main" } }] } },
    { width: W, height: H },
  );
  const was = { left: grid.rect("left").w, rail: grid.rect("rail").w, main: grid.rect("main").w };
  const from = grid.boundaryPos("x", 1);

  const to = grid.moveBoundary("x", 1, 230);
  // A drag changes the two slots that meet at the boundary and no others. The
  // slot before takes the room; the slot after gives it up. Every card standing
  // in either slot follows — a slot has one width.
  const moved = to - from;
  near(to, 230, "the boundary landed where it was sent");
  assert.ok(moved > 0, "and it did move");
  near(grid.rect("left").w, was.left + moved, "left took the room");
  near(grid.rect("rail").w, was.rail - moved, "the rail gave the room");
  near(grid.rect("main").w, was.main, "the slot that does not touch the boundary is untouched");
  assertTiling(grid, "between two fixed cards");
});

test("centring works beside a card with a px size", () => {
  // There is no separate kind of card here, so there is no gesture a card can
  // refuse. A pinned width is a number, and half of it is half of it.
  const grid = edges();
  grid.moveBoundary("x", 1, 300);
  grid.centerBoundary("x", 1);
  assert.ok(
    Math.abs(grid.rect("left").w - grid.rect("upper").w) < 0.01,
    `${grid.rect("left").w} and ${grid.rect("upper").w}`,
  );

  const shared = three();
  shared.moveBoundary("x", 1, 200);
  shared.centerBoundary("x", 1);
  assert.ok(
    Math.abs(shared.rect("sidebar").w - shared.rect("upper").w) < 0.01,
    "two sharing cards come out equal too",
  );

  // Read first, then act: an assertion whose expected side calls a reader after
  // the actual side called a mutator compares the new state with itself.
  const border = grid.boundaryPos("x", 0);
  const before = [...grid.lines("x")];
  assert.equal(grid.centerBoundary("x", 0), border, "a border is not a boundary");
  assert.deepEqual(grid.lines("x"), before, "and centring one moves nothing");
});

test("a cut divides the card's px size between the halves", () => {
  // Half and half by default; a virtual line inside the card decides otherwise.
  // Nothing here is special to a card that has a width — a cut divides whatever
  // the card was.
  const grid = three();
  // The sidebar is drawn 436 and the column 1140, so the level is uneven and the sidebar alone gives the span.
  assert.equal(grid.insertAt("x", 1, { id: "rail", size: 300 }), "rail");
  assert.equal(grid.canSplit("rail", "x"), true, "there is room for two");

  const born = grid.split("rail", "x");
  assert.ok(born, "it was cut");
  assert.ok(
    Math.abs(grid.card("rail").width + grid.card(born).width - 300) < 0.01,
    `the number divides: ${grid.card("rail").width} and ${grid.card(born).width}`,
  );
  assert.ok(
    Math.abs(grid.card("rail").width - 150) < 0.01,
    `half and half by default, not ${grid.card("rail").width}`,
  );
  assertTiling(grid, "after cutting a card that has a fixed width");
});


test("insertAt requires a valid size", () => {
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

test("insertAt is refused when the card that arrives would take another below minSize", () => {
  // `minSize` binds the operations. The size is one the plane holds, so the
  // check above lets it through, and what refuses it is that the cards that give
  // the span would be drawn under the floor.
  const grid = new Soksak(undefined, { width: 1200, height: 800, gap: 24, minSize: 96 });
  assert.ok(grid.split("card", "x"), "two cards sharing the plane");
  const before = [...grid.rects()].map(([id, r]) => [id, r.w]);

  // The two cards are drawn one size, so both give a share. 1000 px and two corridors leave 152 px, which cannot keep 96 each.
  assert.equal(grid.insertAt("x", 1, { id: "rail", size: 1000 }), null, "1000 would draw the cards under 96");
  assert.deepEqual([...grid.rects()].map(([id, r]) => [id, r.w]), before, "and nothing moved");

  // The refusal is the floor, not the operation: a size the cards can give goes in.
  assert.equal(grid.insertAt("x", 1, { id: "rail", size: 300 }), "rail");
  const widths = [...grid.rects().values()].map((r) => r.w);
  assert.ok(Math.min(...widths) >= grid.minSize - 0.01, `every card keeps the floor: ${widths}`);

  // 600 goes in too: neither card alone holds the span, so both give it in proportion and each keeps the floor.
  const wide = new Soksak(undefined, { width: 1200, height: 800, gap: 24, minSize: 96 });
  assert.ok(wide.split("card", "x"), "two cards sharing the plane");
  assert.equal(wide.insertAt("x", 1, { id: "rail", size: 600 }), "rail");
  const shares = [...wide.rects()].map(([id, r]) => [id, r.w]).filter(([id]) => id !== "rail");
  assert.deepEqual(shares.map(([, w]) => w), [276, 276], "both gave the same share");

  // On an uneven level the card before the boundary alone gives the span, so its floor decides: the sidebar is drawn 441.28.
  const uneven = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.28, node: { card: "sidebar" } }, { share: 0.72, node: { cut: "y", kids: [{ share: 0.52, node: { card: "upper" } }, { share: 0.48, node: { card: "lower" } }] } }] } },
    { width: W, height: H },
  );
  const state = uneven.toJSON();
  assert.equal(uneven.insertAt("x", 1, { id: "rail", size: 400 }), null, "441.28 - 400 - 24 leaves the sidebar under 96");
  assert.deepEqual(uneven.toJSON(), state, "and nothing changed");
});

test("setFixed and setSize change a card; writing to cards does not", () => {
  const grid = three();
  assert.equal(Object.isFrozen(grid.card("sidebar")), true, "what came back is a report");
  assert.throws(() => { grid.card("sidebar").fixed = true; }, TypeError, "and writing to it throws");

  assert.equal(grid.setFixed("sidebar", true), true);
  assert.equal(grid.card("sidebar").fixed, true);
  assert.equal(grid.setFixed("nobody", true), false);

  assert.equal(grid.setSize("sidebar", "x", 240), true);
  assert.ok(Math.abs(grid.rect("sidebar").w - 240) < 0.01, "drawn at 240");

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

test("a drag beside a px slot leaves the slot on the far side of it alone", () => {
  const railed = () =>
    new Soksak(
      { root: { cut: "x", kids: [{ share: 0.1, node: { card: "left", fixed: true, width: 190 } }, { share: 0.24999999999999997, node: { cut: "y", kids: [{ share: 0.5, node: { card: "A" } }, { share: 0.5, node: { card: "B" } }] } }, { share: 0.25, node: { card: "rail", fixed: true, width: 190 } }, { share: 0.30000000000000004, node: { cut: "y", kids: [{ share: 0.5, node: { card: "C" } }, { share: 0.5, node: { card: "D" } }] } }, { share: 0.09999999999999998, node: { card: "right", fixed: true, width: 210 } }] } },
      { width: W, height: H },
    );

  // The rail's right boundary. A and B stand on its left and never touch it.
  for (const push of [-60, 40, 160]) {
    const grid = railed();
    const was = Object.fromEntries(grid.cards.map((c) => [c.id, grid.rect(c.id).w]));
    const from = grid.boundaryPos("x", 3);

    const to = grid.moveBoundary("x", 3, from + push, false);
    near(to, from + push, `landed at ${push}`);
    near(grid.rect("rail").w, was.rail + push, "the rail took the room");
    near(grid.rect("C").w, was.C - push, "the slot beside it gave the room");
    near(grid.rect("D").w, was.D - push, "D gave the room");
    for (const id of ["left", "A", "B", "right"]) {
      near(grid.rect(id).w, was[id], `${id} is not at this boundary`);
    }
    assertTiling(grid, `rail boundary ${push}`);
  }

  // And the same from the other side: the rail's left boundary leaves C and D.
  for (const push of [-60, 60]) {
    const grid = railed();
    const was = Object.fromEntries(grid.cards.map((c) => [c.id, grid.rect(c.id).w]));
    const from = grid.boundaryPos("x", 2);

    near(grid.moveBoundary("x", 2, from + push, false), from + push, `landed at ${push}`);
    near(grid.rect("A").w, was.A + push, "the pane before took the room");
    near(grid.rect("rail").w, was.rail - push, "the rail gave the room");
    for (const id of ["left", "C", "D", "right"]) {
      near(grid.rect(id).w, was[id], `${id} is not at this boundary`);
    }
    assertTiling(grid, `left of the rail ${push}`);
  }
});

test("a sidebar leaving and returning is settled with the cards that share", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.1, node: { card: "left", fixed: true, width: 190 } }, { share: 0.24999999999999997, node: { cut: "y", kids: [{ share: 0.5, node: { card: "A" } }, { share: 0.5, node: { card: "B" } }] } }, { share: 0.25, node: { card: "rail", fixed: true, width: 190 } }, { share: 0.30000000000000004, node: { cut: "y", kids: [{ share: 0.5, node: { card: "C" } }, { share: 0.5, node: { card: "D" } }] } }, { share: 0.09999999999999998, node: { card: "right", fixed: true, width: 210 } }] } },
    { width: W, height: H },
  );
  const was = Object.fromEntries(grid.cards.map((c) => [c.id, grid.rect(c.id).w]));
  const last = () => grid.lines("x").length - 1;
  // Re-proportioning divides, so widths come back to within a rounding.
  const near = (id, w, note) =>
    assert.ok(Math.abs(grid.rect(id).w - w) < 1e-9, `${id} is ${grid.rect(id).w}, not ${w}: ${note}`);
  // The px sizes and the corridors are costs; the shares of the two panes are 0.25 and 0.3 of what is left.
  // The corridors and the px sizes are costs of the cut, and the two panes share what they leave in the proportion
  // 0.25 : 0.3 of their fractions.
  const gap = grid.gap;

  grid.setFixed("left", false);
  assert.equal(grid.close("left"), true);
  // Both panes take the sidebar's share by one factor, so the ratio of their shares holds; the cards that hold a fixed card keep their width.
  const rest = W - 190 - 210 - 3 * gap;
  near("A", (rest * 0.25) / 0.55, "took its part of the share");
  near("C", (rest * 0.3) / 0.55, "took its part of the share");
  near("rail", 190, "a px size is declared, not divided");
  near("right", was.right, "a px size is declared, not divided");

  grid.setFixed("right", false);
  assert.equal(grid.close("right"), true);
  const left = W - 190 - 2 * gap;
  near("A", (left * 0.25) / 0.55, "took its part of the share");
  near("C", (left * 0.3) / 0.55, "took its part of the share");
  near("rail", 190, "a px size is declared, not divided");

  // At the edge of the plane every card that holds no px size gives a share in proportion, so the ratio holds.
  assert.equal(grid.insertAt("x", 0, { id: "left", size: 190 }), "left");
  const room = W - 190 - 190 - 3 * gap;
  near("left", 190, "arrives at the size it asked for");
  near("A", (room * 0.25) / 0.55, "gave its share in proportion");
  near("C", (room * 0.3) / 0.55, "gave its share in proportion");

  assert.equal(grid.insertAt("x", last(), { id: "right", size: 210 }), "right");
  for (const [id, w] of Object.entries(was)) near(id, w, "ratio scaling at an edge restores it");
  assertTiling(grid, "sidebars back");
});

test("with nothing sharing, px sizes are scaled to cover the plane", () => {
  // The slots always sum to the plane. With no sharing slot on the axis the px
  // sizes are the only thing that can cover it, so they become proportions.
  const one = new Soksak(undefined, { width: 1600, height: 1000 });
  assert.equal(one.setSize("card", "x", 200), true);
  assert.equal(one.rect("card").w, 1600, "the only card covers the plane");

  const two = new Soksak(undefined, { width: 1600, height: 1000 });
  const b = two.split("card", "x");
  two.setSize("card", "x", 200);
  two.setSize(b, "x", 300);
  const wide = two.rect(b).w;
  const narrow = two.rect("card").w;
  assert.ok(Math.abs(narrow / wide - 200 / 300) < 1e-9, "the proportions asked for survive");
  assert.ok(Math.abs(narrow + wide + two.gap - 1600) < 1e-9, "and they cover the plane");

  // One sharing slot is enough for the px size to be the drawn size.
  const shared = new Soksak(undefined, { width: 1600, height: 1000 });
  shared.split("card", "x");
  shared.setSize("card", "x", 200);
  assert.equal(shared.rect("card").w, 200);
});

/** A px card of 230 and three sharing cards, the second of which holds a thin share of the plane. */
const crowded = () =>
  new Soksak(
    { root: { cut: "x", kids: [{ share: 0.3, node: { card: "n1" } }, { share: 0.04, node: { card: "n2" } }, { share: 0.2, node: { card: "n3", width: 230 } }, { share: 0.46, node: { card: "card" } }] } },
    { width: 1600, height: 1000, gap: 24, minSize: 96 },
  );

test("a plane too small for its cards draws each sharing card at its fraction of what the px size leaves", () => {
  const grid = crowded();
  grid.resize(453, 469);   // less than 230 + three minimums + three corridors

  const box = grid.rects();
  for (const [id, r] of box) {
    assert.ok(r.w >= 0 && r.h >= 0, `${id} is ${r.w}x${r.h}`);
    assert.ok(r.x >= -1e-9 && r.x + r.w <= 453 + 1e-9, `${id} runs past the plane`);
  }
  // The corridors and the px size are costs, and the three sharing cards divide the 151 px that they leave by their
  // fractions 0.3, 0.04 and 0.46; n2 is drawn below minSize, which a resize does not refuse.
  near(box.get("n3").w, 230, "the px size is kept while the room holds one minSize besides it");
  const rest = 453 - 230 - 3 * 24;
  for (const [id, share] of [["n1", 0.3], ["n2", 0.04], ["card", 0.46]]) near(box.get(id).w, (rest * share) / 0.8, id);
});

test("height is the same rule as width, on the other axis", () => {
  // R2 promises one rule for both axes. Every other setSize test here works on
  // x, so the y half of the code had never run.
  const grid = new Soksak(undefined, { width: 1200, height: 900, gap: 24 });
  const below = grid.split("card", "y", { id: "below" });
  grid.split("card", "x", { id: "beside" });

  assert.equal(grid.setSize("card", "y", 200), true);
  assert.equal(grid.card("card").height, 200);
  assert.equal(grid.rect("card").h, 200, "the px size is the drawn size on y too");
  assert.equal(grid.card("beside").height, 200, "and every card in the slot takes it");
  assert.equal(grid.rect(below).h, 900 - 200 - grid.gap, "the rest is what is left");

  // Dragging the boundary beside it changes that size, as on x.
  const from = grid.boundaryPos("y", 1);
  assert.equal(grid.moveBoundary("y", 1, from + 50), from + 50);
  assert.equal(grid.rect("card").h, 250);
  assert.equal(grid.rect(below).h, 900 - 250 - grid.gap);

  // And null gives the slot back to the share.
  assert.equal(grid.setSize("card", "y", null), true);
  assert.equal(grid.card("card").height, undefined);
  assertTiling(grid, "after sizing on y");
});

test("the options are readable and writable after construction", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 900 });
  assert.equal(grid.minSize, 96);

  // Half of 1200 less the corridor is 588, so 700 refuses and 96 does not.
  grid.minSize = 700;
  assert.equal(grid.minSize, 700);
  assert.equal(grid.split("card", "x"), null, "a split that would go under it is refused");

  for (const bad of [-1, NaN, Infinity]) {
    grid.minSize = bad;
    assert.equal(grid.minSize, 700, `${bad} is ignored`);
  }
  grid.minSize = 96;
  assert.ok(grid.split("card", "x"), "and lowering it lets the split through");
});

test("a plane too small keeps the corridor between neighbours", () => {
  // 453px holding cards that need 590. Something has to give, and it is the
  // width of the card that runs out of room — not the gap beside it.
  const grid = crowded();
  grid.resize(453, 469);

  const across = [...grid.rects()].sort((a, b) => a[1].x - b[1].x);
  for (let i = 1; i < across.length; i++) {
    const [before, a] = across[i - 1];
    const [after, b] = across[i];
    assert.ok(
      Math.abs(b.x - (a.x + a.w) - grid.gap) < 1e-6,
      `${before} to ${after} is ${b.x - (a.x + a.w)}, not ${grid.gap}`,
    );
  }
  const drawn = across.reduce((n, [, r]) => n + r.w, 0);
  assert.ok(Math.abs(drawn + 3 * grid.gap - 453) < 1e-6, "and the plane is covered exactly");
  for (const [id, r] of across) assert.ok(r.w >= 0, `${id} is ${r.w}`);
});

test("a slot never comes out narrower than the corridor it carries", () => {
  for (const [w, h] of [[453, 469], [300, 300], [200, 900], [120, 120]]) {
    const grid = new Soksak(undefined, { width: 1400, height: 900, gap: 24, minSize: 96 });
    grid.split("card", "x", { id: "b" });
    grid.split("b", "x", { id: "c" });
    grid.split("card", "y", { id: "d" });
    grid.resize(w, h);
    for (const axis of ["x", "y"]) {
      const along = grid.lines(axis).map((_, k) => grid.boundaryPos(axis, k));
      for (let k = 1; k < along.length; k++) {
        assert.ok(along[k] >= along[k - 1] - 1e-9, `${w}x${h}: ${axis} line ${k} is before ${k - 1}`);
      }
    }
    for (const [id, r] of grid.rects()) assert.ok(r.w >= 0 && r.h >= 0, `${w}x${h}: ${id} is ${r.w}x${r.h}`);
  }
});

test("a drag that does not move the boundary leaves the declared size alone", () => {
  // The plane is too small for the 400 the card declares, so it is drawn at 300.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "side", width: 400 } }, { share: 0.5, node: { card: "pane" } }] } },
    { width: 420, height: 600, gap: 24, minSize: 96 },
  );
  assert.equal(grid.card("side").width, 400, "it declares 400");
  assert.equal(grid.rect("side").w, 300, "and is drawn at 300");

  // The first move of every drag is to where the boundary already is.
  const at = grid.boundaryPos("x", 1);
  for (let i = 0; i < 8; i++) grid.moveBoundary("x", 1, at, false);
  assert.equal(grid.boundaryPos("x", 1), at, "the boundary stays where it is");
  assert.equal(grid.card("side").width, 400, "and the card still declares 400");

  grid.resize(1600, 600);
  assert.equal(grid.rect("side").w, 400, "a plane that holds it draws it at 400");
});

test("a drag reaches the size it asks for when the plane holds less than it is told", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "side", width: 400 } }, { share: 0.5, node: { card: "pane", width: 400 } }] } },
    { width: 500, height: 600, gap: 24, minSize: 96 },
  );
  grid.moveBoundary("x", 1, 300, false);
  assert.ok(
    Math.abs(grid.boundaryPos("x", 1) - 300) < 0.01,
    `the boundary reaches 300, not ${grid.boundaryPos("x", 1)}`,
  );
});

test("a boundary with a declared size on one side of it does not move a plane that holds less than it is told", () => {
  const build = () =>
    new Soksak(
      { root: { cut: "y", kids: [{ share: 0.3, node: { card: "n1", height: 272 } }, { share: 0.4, node: { card: "n0", height: 327 } }, { share: 0.3, node: { card: "card" } }] } },
      { width: 1264, height: 541, gap: 5, minSize: 75 },
    );

  // n0 declares a size and `card` shares, and the plane holds less than the two
  // declarations ask for. Every way of moving the line between them changes the
  // size a third card is drawn at, so the line stays where it is.
  const one = build();
  const at = one.boundaryPos("y", 2);
  assert.deepEqual(one.boundaryRange("y", 2), [at, at], "the range is the one position");
  const was = [...one.cards].map((c) => one.rect(c.id).h);
  one.centerBoundary("y", 2);
  one.moveBoundary("y", 2, at - 100, false);
  assert.deepEqual([...one.cards].map((c) => one.rect(c.id).h), was, "nothing moved");

  // The line between the two declared sizes moves, because the pair keeps the
  // total it declares and no other card is redrawn.
  const two = build();
  const third = two.rect("card").h;
  two.centerBoundary("y", 1);
  assert.ok(
    Math.abs(two.rect("n1").h - two.rect("n0").h) < 0.02,
    `the two cards come out the same size, not ${two.rect("n1").h} and ${two.rect("n0").h}`,
  );
  assert.ok(
    Math.abs(two.rect("card").h - third) < 1e-9,
    `the card that does not meet it keeps its size, ${two.rect("card").h} against ${third}`,
  );
});

test("a card that comes to span two slots loses the size it declared", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.4, node: { cut: "y", kids: [{ share: 0.5, node: { card: "side", width: 400 } }, { share: 0.5, node: { card: "low" } }] } }, { share: 0.6, node: { card: "main" } }] } },
    { width: 1200, height: 800, gap: 24 },
  );
  assert.equal(grid.card("side").width, 400, "it declares a width");

  // The split puts a line inside the column both cards stand in, so `side` comes
  // to span two slots without being split itself.
  grid.split("low", "x");
  assert.equal(grid.card("side").c1 - grid.card("side").c0, 2, "side now spans two slots");
  assert.equal(grid.card("side").width, undefined, "and carries no px size");
});

test("a drag between two declared slots moves no third one", () => {
  // The plane holds 1600 and the three cards declare 900 between them, so every
  // declared size is drawn scaled.
  const build = () =>
    new Soksak(
      { root: { cut: "x", kids: [{ share: 0.3333333333333333, node: { card: "a", width: 200 } }, { share: 0.3333333333333333, node: { card: "b", width: 300 } }, { share: 0.33333333333333337, node: { card: "c", width: 400 } }] } },
      { width: 1600, height: 800, gap: 24, minSize: 96 },
    );

  for (const ask of [200, 400, 600]) {
    const grid = build();
    const was = grid.rect("c");
    const at = grid.moveBoundary("x", 1, ask, false);
    assert.ok(Math.abs(at - ask) < 0.01, `the boundary reaches ${ask}, not ${at}`);
    const now = grid.rect("c");
    assert.ok(
      Math.abs(now.x - was.x) < 0.01 && Math.abs(now.w - was.w) < 0.01,
      `c is drawn at ${now.x}/${now.w}, not ${was.x}/${was.w}`,
    );
  }
});

test("a card inserted at a boundary of an uneven level is taken from the card before it, and a close shares by ratio", () => {
  const grid = new Soksak(
    { root: { cut: "y", kids: [{ share: 0.8, node: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "b" } }] } }, { share: 0.19999999999999996, node: { card: "low" } }] } },
    { width: 800, height: 600, gap: 24, minSize: 96 },
  );
  // The two fractions of the 576 px after the corridor.
  const [upper, lower] = [0.8 * 576, 0.2 * 576];
  for (const [id, h] of [["a", upper], ["b", upper], ["low", lower]]) near(grid.rect(id).h, h, `${id} is drawn at its fraction`);

  assert.equal(grid.insertAt("y", 1, { size: 120, id: "rail" }), "rail");
  assert.equal(grid.rect("rail").h, 120, "the rail stands at the size it asked for");
  for (const [id, h] of [["a", upper - 120 - grid.gap], ["b", upper - 120 - grid.gap], ["low", lower]]) {
    assert.ok(Math.abs(grid.rect(id).h - h) < 1e-9, `${id} is ${grid.rect(id).h}, not ${h}: the card before the boundary alone gave the span`);
  }

  // The rail leaves its cut; the two kids that remain take its share by one factor, so the ratio of their slots holds.
  assert.equal(grid.close("rail"), true);
  const paid = upper - 120 - grid.gap;
  const top = (576 * paid) / (paid + lower);
  near(grid.rect("a").h, top, "a");
  near(grid.rect("b").h, top, "b");
  near(grid.rect("low").h, 576 - top, "low");
  assert.ok(grid.rect("low").h > lower, "so the uneven level is not restored to the heights it had");
  assertTiling(grid, "after the rail left an uneven level");
});

test("a card inserted at a boundary of an even level is closed back to the heights it had", () => {
  const grid = new Soksak(undefined, { width: 800, height: 600, gap: 24, minSize: 96 });
  grid.split("card", "y");
  const was = [...grid.rects()].map(([id, r]) => [id, r.h]);

  assert.equal(grid.insertAt("y", 1, { size: 120, id: "rail" }), "rail");
  assert.deepEqual(
    [...grid.rects()].filter(([id]) => id !== "rail").map(([, r]) => r.h),
    [216, 216],
    "both kids gave the same share",
  );
  assert.equal(grid.close("rail"), true);
  assert.deepEqual([...grid.rects()].map(([id, r]) => [id, r.h]), was, "ratio scaling gives every height back");
});

test("an axis where every declared size is zero still covers the plane", () => {
  const grid = new Soksak(undefined, { width: 800, height: 600, gap: 24, minSize: 96 });
  assert.equal(grid.setSize("card", "y", 0), true, "zero is a size");
  assert.equal(grid.rect("card").h, 600, "the one card still fills the plane");
});

test("a drag rewrites no span between the sharing slots it does not meet", () => {
  // `card` and `card-1` stand on the two sharing slots and touch neither side of
  // line 1. The plane holds less than the three declarations ask for, so each
  // sharing slot is drawn its corridor plus a share of the span.
  const grid = new Soksak(
    { root: { cut: "y", kids: [{ share: 0.3471777676167251, node: { card: "card-3", height: 237 } }, { share: 0.09118909719046892, node: { card: "card-2", height: 327 } }, { share: 0.09118909719046897, node: { card: "card" } }, { share: 0.18237819438093783, node: { card: "card-1" } }, { share: 0.2880658436213992, node: { card: "card-4", height: 140 } }] } },
    { width: 932, height: 486, gap: 24, minSize: 20 },
  );
  const was = ["card", "card-1"].map((id) => grid.rect(id).h);

  const at = grid.moveBoundary("y", 1, 180, false);
  assert.ok(Math.abs(at - 180) < 0.01, `the boundary reaches 180, not ${at}`);
  const now = ["card", "card-1"].map((id) => grid.rect(id).h);
  for (const [i, id] of ["card", "card-1"].entries()) {
    assert.ok(
      Math.abs(now[i] - was[i]) < 0.01,
      `${id} is drawn at ${now[i]}, not ${was[i]}`,
    );
  }
});

test("a card inserted at a boundary of an even level and closed again restores every width", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "card-3" } }, { share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "card-4" } }, { share: 0.5, node: { card: "card" } }] } }] } }, { share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "card-5" } }, { share: 0.5, node: { card: "card-1" } }] } }, { share: 0.5, node: { card: "card-2" } }] } }] } },
    { width: 995, height: 920, gap: 24, minSize: 96 },
  );
  const ids = [...grid.cards].map((c) => c.id);
  const was = ids.map((id) => grid.rect(id).w);

  // The two columns are drawn one size, so both give a share of the span in proportion;
  // the close takes the rail out and scales them back by the same factor.
  grid.insertAt("x", 2, { size: 120, id: "rail" });
  grid.close("rail");

  for (const [i, id] of ids.entries()) {
    assert.ok(
      Math.abs(grid.rect(id).w - was[i]) < 0.01,
      `${id} is back to ${was[i]}, not ${grid.rect(id).w}`,
    );
  }
});

test("a card wider than either card beside it takes its span from both in proportion", () => {
  const grid = new Soksak(undefined, { width: 900, height: 600, gap: 24, minSize: 20 });
  grid.split("card", "x");
  const was = [...grid.cards].map((c) => ({ id: c.id, w: grid.rect(c.id).w }));

  // Neither card alone holds 600 px, so both give a share in proportion: 900 less 600 and two corridors is 252.
  assert.equal(grid.insertAt("x", 1, { size: 600, id: "wide" }), "wide");
  assert.equal(grid.rect("wide").w, 600);
  for (const card of was) {
    assert.ok(Math.abs(grid.rect(card.id).w - 126) < 0.01, `${card.id} is ${grid.rect(card.id).w}, not 126`);
  }
  grid.close("wide");

  for (const card of was) {
    assert.ok(
      Math.abs(grid.rect(card.id).w - card.w) < 0.01,
      `${card.id} is back to ${card.w}, not ${grid.rect(card.id).w}`,
    );
  }
});

test("centring reaches the middle on a plane that draws its sizes scaled", () => {
  // 602 + 331 px of declared width and three corridors do not fit 992 px, so
  // every declared size is drawn scaled. The move changes that scale, so where
  // a move lands is not where it was asked for: the middle is measured again
  // after each move until the two cards come out the same size.
  const grid = new Soksak(undefined, { width: 992, height: 500, gap: 12, minSize: 15 });
  const second = grid.split("card", "x");
  const wide = grid.split(second, "x");
  const narrow = grid.split(second, "x");
  grid.setSize(wide, "x", 602);
  grid.setSize(narrow, "x", 331);
  grid.centerBoundary("x", 1);
  assert.ok(
    Math.abs(grid.rect("card").w - grid.rect(second).w) < 0.01,
    `${grid.rect("card").w} and ${grid.rect(second).w}`,
  );
});

test("a cut halves the card on a plane that draws its declared sizes scaled", () => {
  const grid = new Soksak({ root: { cut: "x", kids: [{ share: 0.55, node: { card: "left" } }, { share: 0.2699999999999999, node: { card: "rail", width: 123 } }, { share: 0.18000000000000005, node: { cut: "y", kids: [{ share: 0.64, node: { card: "top", height: 148 } }, { share: 0.36, node: { card: "bottom" } }] } }] } }, { width: 292, height: 218, gap: 32, minSize: 60 });
  assert.equal(grid.rect("left").h, 218);
  // A plain split would take the line between `top` and `bottom`, which leaves `minSize` below it; a new line halves the card.
  assert.equal(grid.split("left", "y", { id: "new", newLine: true }), "new");
  assert.equal(grid.rect("left").h, 93);
  assert.equal(grid.rect("new").h, 93);
});

test("a gap change re-expresses the proportions and never rewrites them", () => {
  const grid = new Soksak({ root: { cut: "y", kids: [{ share: 0.2, node: { card: "top" } }, { share: 0.2, node: { card: "mid" } }, { share: 0.6, node: { card: "bot", height: 400 } }] } }, { width: 900, height: 634, gap: 0, minSize: 96 });
  grid.moveBoundary("y", 2, grid.boundaryRange("y", 2)[0], false);
  const parked = grid.rect("mid").h;
  near(parked, 96, "the range ends where mid is minSize");
  const ys = grid.lines("y");

  // the slot carries the corridor, so a wider gap draws a sharing card smaller
  grid.gap = 24;
  assert.ok(grid.rect("mid").h < grid.minSize);

  // and a theme that moves the gap and moves it back changes nothing
  for (let k = 0; k < 20; k++) { grid.gap = 7; grid.gap = 4; }
  grid.gap = 0;
  assert.equal(grid.rect("mid").h, parked);
  assert.deepEqual(grid.lines("y"), ys);
});

test("a card that declares its size is drawn at it whatever the gap", () => {
  // no second declared size, so the plane holds what the axis declares
  const grid = new Soksak({ root: { cut: "y", kids: [{ share: 0.2, node: { card: "top" } }, { share: 0.2, node: { card: "mid", height: 96 } }, { share: 0.6, node: { card: "bot" } }] } }, { width: 900, height: 634, gap: 0, minSize: 96 });
  for (const px of [0, 4, 6, 7, 24, 60]) {
    grid.gap = px;
    assert.equal(grid.rect("mid").h, 96, `gap ${px}`);
  }
});

test("a drag past the limit stops at the limit, not one rounding short of it", () => {
  // A pane and a sidebar. The end of the range is where the pane is drawn at
  // `minSize`, which is also where the plane exactly holds what the sidebar
  // declares there: the two are the same number, so the last position the range
  // names sits on the equality that the layout of the cut tests. The size that
  // position asks for is measured from a line position that carries one rounding
  // per slot.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.28, node: { card: "pane" } }, { share: 0.72, node: { card: "side", width: 137 } }] } },
    { width: 800, height: 600, gap: 24, minSize: 96 },
  );
  const [min] = grid.boundaryRange("x", 1);
  assert.equal(min, grid.minSize + grid.gap / 2, "the range ends where the pane is minSize");

  assert.equal(grid.moveBoundary("x", 1, 0, false), min, "dragged past it, the boundary stops at it");
  assert.equal(grid.rect("pane").w, grid.minSize);
  assert.equal(grid.rect("side").w, 800 - min - grid.gap / 2, "the sidebar took the rest");
  assertTiling(grid, "at the end of the range");
});

test("a card narrower than minSize takes its width from the card before the boundary on an uneven level", () => {
  // The rail declares 48 where `minSize` is 96. That number is the host's and no
  // settle can raise it: a slot with a px size is drawn what it declares. The
  // level is uneven, so the card before the boundary alone gives the span and
  // the card on the far side of the boundary keeps its width.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.325, node: { card: "left" } }, { share: 0.675, node: { card: "right" } }] } },
    { width: 1200, height: 800, gap: 24, minSize: 96 },
  );
  // The two fractions of the 1176 px after the corridor.
  near(grid.rect("left").w, 382.2, "left");
  near(grid.rect("right").w, 793.8, "right");

  assert.equal(grid.insertAt("x", 1, { id: "rail", size: 48 }), "rail");
  assert.equal(grid.rect("rail").w, 48, "the rail is drawn what it declares");
  near(grid.rect("left").w, 382.2 - 48 - grid.gap, "the card before the boundary gave the span");
  near(grid.rect("right").w, 793.8, "the card after it kept its width");

  // The close shares the rail's share by one factor, so the ratio of the two cards holds and the level is no longer the one it was.
  assert.equal(grid.close("rail"), true);
  const paid = 382.2 - 48 - grid.gap;
  const left = (1176 * paid) / (paid + 793.8);
  near(grid.rect("left").w, left, "left");
  near(grid.rect("right").w, 1176 - left, "right");
});

test("a boundary beside a card with a px size is shared by every card without one", () => {
  const build = () =>
    new Soksak(
      { root: { cut: "x", kids: [{ share: 0.2, node: { card: "side", width: 200 } }, { share: 0.3, node: { card: "a" } }, { share: 0.5, node: { card: "b" } }] } },
      { width: 1200, height: 800, gap: 24, minSize: 96 },
    );

  // a and b share the 952 px that the px size and the corridors leave, 0.3 : 0.5.
  assert.deepEqual(["a", "b"].map((id) => build().rect(id).w), [357, 595]);

  // The kid before the boundary holds a px size, so both other kids give a share in proportion: 828 px, 0.3 : 0.5.
  const beside = build();
  assert.equal(beside.insertAt("x", 1, { id: "rail", size: 100 }), "rail");
  assert.equal(beside.rect("side").w, 200, "the px size is kept");
  near(beside.rect("a").w, 310.5, "a");
  near(beside.rect("b").w, 517.5, "b");

  // The boundary between two cards without a px size, drawn at different sizes: the one before it alone gives the span.
  const between = build();
  assert.equal(between.insertAt("x", 2, { id: "rail", size: 100 }), "rail");
  near(between.rect("a").w, 357 - 100 - between.gap, "a");
  near(between.rect("b").w, 595, "the card after the boundary keeps its size");

  // An edge of the plane: every card without a px size gives a share in proportion.
  const edge = build();
  assert.equal(edge.insertAt("x", 0, { id: "rail", size: 100 }), "rail");
  assert.equal(edge.rect("side").w, 200);
  near(edge.rect("a").w, 310.5, "a");
  near(edge.rect("b").w, 517.5, "b");
});

test("the state holds only the root", () => {
  const grid = new Soksak(undefined, { width: 900, height: 600 });
  grid.split("card", "x");
  grid.insertAt("x", 1, { size: 200, id: "rail" });
  assert.deepEqual(Object.keys(grid.toJSON()), ["root"], "nothing records who gave a span");
  assert.throws(
    () => new Soksak({ root: { card: "a" }, paidBy: {} }, { width: 100, height: 100 }),
    /paidBy/,
    "a state that holds the removed record is rejected",
  );
});

test("a card that comes to span the whole axis loses the size it declared", () => {
  // `head` declares a height and holds one row slot. Closing `body` gives it the
  // other, and R5 says a card spanning two slots carries no px size, so `head`
  // is measured as a sharing card over the plane.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.2, node: { card: "side", fixed: true, width: 190 } }, { share: 0.39999999999999997, node: { cut: "y", kids: [{ share: 0.3, node: { card: "head", height: 200 } }, { share: 0.7, node: { card: "body" } }] } }, { share: 0.4, node: { card: "rail", fixed: true, width: 210 } }] } },
    { width: 900, height: 634, gap: 24, minSize: 96 },
  );
  assert.equal(grid.rect("head").h, 200, "declared while it holds one slot");

  assert.equal(grid.close("body"), true);
  assert.equal(grid.card("head").height, undefined, "the size went with the second slot");
  assert.equal(grid.card("head").r1 - grid.card("head").r0, 1, "head holds the whole height");
  assert.equal(grid.rect("head").h, 634, "and is drawn over the plane");

  const born = grid.split("head", "y");
  assert.ok(born, "and the cut lands on it");
  assert.ok(
    Math.abs(grid.rect("head").h - grid.rect(born).h) < 0.01,
    `the halves are drawn ${grid.rect("head").h} and ${grid.rect(born).h}`,
  );
});

test("a cut across a card is its own cut whatever the cards of another cut declare", () => {
  // Both cards of the cut below `rail` declare a width of zero, and with nothing
  // that shares they divide the width in their proportion. `rail` stands in
  // the cut along y, so a cut of it along x is a new cut of two halves, and the
  // cards below keep their widths.
  const grid = new Soksak(
    { root: { cut: "y", kids: [{ share: 0.268, node: { card: "rail", height: 268 } }, { share: 0.732, node: { cut: "x", kids: [{ share: 0.5, node: { card: "p", width: 0 } }, { share: 0.5, node: { card: "q", width: 0 } }] } }] } },
    { width: 1600, height: 1000, gap: 0, minSize: 0 },
  );
  assert.equal(grid.rect("rail").w, 1600, "the rail reaches across");

  assert.equal(grid.canSplit("rail", "x"), true);
  const born = grid.split("rail", "x");
  assert.ok(born, "the cut goes in");
  assert.deepEqual([grid.rect("rail").w, grid.rect(born).w], [800, 800], "two halves");
  assert.deepEqual([grid.rect("p").w, grid.rect("q").w], [800, 800], "and the cards below keep their widths");
});

test("a card inserted where every kid of the root holds a px size takes a share from every kid", () => {
  const grid = new Soksak({ root: { cut: "x", kids: [{ share: 0.4, node: { card: "p", width: 200 } }, { share: 0.6, node: { card: "q", width: 300 } }] } }, { width: 1600, height: 600, gap: 0, minSize: 20 });
  assert.equal(grid.insertAt("x", 2, { id: "n", size: 262 }), "n");
  assert.deepEqual(grid.cards.map((c) => c.id), ["p", "q", "n"]);
});
