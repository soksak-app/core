import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, fuzz, H, make, three, W } from "./helpers.mjs";

test("dragging a line moves every card referencing it", () => {
  const grid = three();
  grid.split("terminal", "x");
  grid.split("browser", "x");
  const before = ["terminal", "browser"].map((id) => grid.rect(id).w);
  grid.moveBoundary("x", 2, 0.5 * W);
  const after = ["terminal", "browser"].map((id) => grid.rect(id).w);
  assert.ok(after[0] !== before[0]);
  assert.equal(after[0].toFixed(4), after[1].toFixed(4), "both follow the same line");
  assertTiling(grid, "after a shared drag");
});

test("a drag stops where a card would fall under minSize", () => {
  const grid = three();
  grid.moveBoundary("x", 1, -5 * W);
  assertTiling(grid, "pushed to the start");
  grid.moveBoundary("x", 1, 5 * W);
  assertTiling(grid, "pushed to the end");
});

/** A line no card reads, made the way one is really made: split, then close. */
function withVirtualLine() {
  // Two rows. Splitting the top row and closing the new card leaves the line
  // for the bottom row, which still spans it. In a single-row plane the close
  // restores the previous spans and there is no line left over.
  const grid = new Soksak(
    { xs: [0, 0.5, 1], ys: [0, 0.5, 1], cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "under", c0: 0, c1: 2, r0: 1, r1: 2 },
    ] },
    { width: W, height: H },
  );
  grid.split("b", "x");
  grid.close(grid.cards.at(-1).id);
  const line = [1, 2].find((k) => grid.isVirtual("x", k));
  assert.ok(line !== undefined, "the closed card left its line");
  return { grid, virtual: line };
}

test("an unreferenced line does not limit a drag", () => {
  const { grid, virtual } = withVirtualLine();
  const boundary = virtual - 1;
  const [, max] = grid.boundaryRange("x", boundary);
  assert.ok(
    max > grid.boundaryPos("x", virtual),
    "the range reaches past it to the nearest line a card actually reads",
  );

  const lines = grid.lines("x").length;
  grid.moveBoundary("x", boundary, W);
  assert.equal(grid.lines("x").length, lines - 1, "and passing it removes it");
  assert.ok(grid.lines("x").every((v, i, all) => i === 0 || v >= all[i - 1]), "the lines stay in order");
  assertTiling(grid, "after passing a virtual line");
});

test("a drag stops at a line a card references", () => {
  const grid = three({ snap: "off" });
  const boundary = 1;
  const [, max] = grid.boundaryRange("x", boundary);
  const next = grid.boundaryPos("x", 2);
  assert.ok(max <= next + 0.01, "it cannot pass a line that is holding a card");
  grid.moveBoundary("x", boundary, W);
  assert.ok(grid.boundaryPos("x", boundary) <= next + 0.01);
  assertTiling(grid, "stopped at a real boundary");
});

test("coincident lines merge and no card loses its size", () => {
  // snap brings the boundary exactly onto its neighbour; merge folds the two
  const { grid, virtual } = withVirtualLine();
  const boundary = virtual - 1;
  const target = grid.boundaryPos("x", virtual);
  grid.moveBoundary("x", boundary, target - 3);   // inside snapDistance
  assert.equal(grid.boundaryPos("x", boundary), target, "snapped exactly onto it");

  const cards = grid.cards.length;
  const lines = grid.lines("x").length;
  assert.equal(grid.mergeCoincident("x", boundary), true);
  assert.equal(grid.lines("x").length, lines - 1);
  assert.equal(grid.cards.length, cards, "no card was lost");
  assertTiling(grid, "after merging two lines");
});

test("merge is refused when snap is off", () => {
  const { grid, virtual } = withVirtualLine();
  const boundary = virtual - 1;
  grid.snap = "off";
  const lines = grid.lines("x").length;
  grid.moveBoundary("x", boundary, grid.boundaryPos("x", virtual) - 3);
  assert.equal(grid.mergeCoincident("x", boundary), false);
  assert.equal(grid.lines("x").length, lines);
});

test("centring makes the two cards beside a line the same size", () => {
  const grid = three();
  grid.moveBoundary("x", 1, 0.12 * W);
  grid.centerBoundary("x", 1);
  const a = grid.rect("sidebar");
  const b = grid.rect("terminal");
  assert.ok(Math.abs(a.w - b.w) < 0.01, `${a.w} vs ${b.w}`);

  grid.centerBoundary("y", 1);
  const top = grid.rect("terminal");
  const bottom = grid.rect("browser");
  assert.ok(Math.abs(top.h - bottom.h) < 0.01, `${top.h} vs ${bottom.h}`);
  assertTiling(grid, "after centring");
});

test("centring past a line no card reads moves that boundary and no other", () => {
  const grid = make({ gap: 24 });
  grid.split("card", "x");
  grid.split("card", "y");
  // A line no card reads, between the boundary to centre and the one before it.
  const spare = grid.split("card", "x");
  grid.close(spare);
  grid.split("card-1", "x");
  grid.moveBoundary("x", 2, 0.66 * W, false);
  grid.moveBoundary("x", 1, 0.58 * W, false);
  assert.equal(grid.isVirtual("x", 1), true, "the line the centring passes is read by no card");
  const far = grid.boundaryPos("x", 3);

  grid.centerBoundary("x", 2);

  const a = grid.rect("card");
  const b = grid.rect("card-1");
  assert.ok(Math.abs(a.w - b.w) < 0.01, `the two cards beside it come out ${a.w} and ${b.w}`);
  assert.equal(grid.lines("x").length, 4, "the line the centring passed is gone");
  assert.ok(
    Math.abs(grid.boundaryPos("x", 2) - far) < 0.01,
    `the boundary above it stays at ${far}, not ${grid.boundaryPos("x", 2)}`,
  );
});

test("an unreferenced line survives a close and is removed by tidy", () => {
  const grid = three();
  grid.split("terminal", "y");
  grid.split("terminal", "y");
  assert.equal(grid.virtualCount(), 0);
  const lines = grid.lines("y").length;

  const spare = grid.cards.find((p) => p.id.startsWith("card-"));
  grid.close(spare.id);
  assert.equal(grid.lines("y").length, lines, "the line stays as a snap target");
  assert.equal(grid.virtualCount(), 1);

  assert.equal(grid.tidy(), 1);
  assert.equal(grid.lines("y").length, lines - 1);
  assert.equal(grid.virtualCount(), 0);
  assertTiling(grid, "after tidy");
});

test("dividers cover referenced lines; rules cover every line", () => {
  const grid = three();
  grid.split("terminal", "x");
  const dividers = grid.dividers();
  const rules = grid.rules();

  for (const d of dividers) {
    assert.ok(d.w > 0 && d.h > 0);
    assert.ok(Math.max(d.w, d.h) > Math.min(d.w, d.h), "a grab area runs along its line");
  }
  const virtual = rules.filter((r) => r.virtual && r.axis === "x" && r.line === 2);
  const real = rules.filter((r) => !r.virtual && r.axis === "x" && r.line === 2);
  assert.equal(virtual.length, 1, "one full-plane rule per line");
  assert.equal(virtual[0].h, H, "it spans the plane, and stops there");
  assert.ok(real.length >= 1);
  assert.ok(real.every((r) => r.h <= virtual[0].h), "real stretches are no longer");

  // The view places these inside the host's element, so anything past the
  // plane gives the host a scrollbar.
  for (const r of rules) {
    assert.ok(r.x >= -0.6 && r.y >= -0.6, `${r.key} starts before the plane`);
    assert.ok(r.x + r.w <= W + 0.6 && r.y + r.h <= H + 0.6, `${r.key} runs past the plane`);
  }
  for (const d of dividers) {
    assert.ok(d.x >= 0 && d.y >= 0 && d.x + d.w <= W && d.y + d.h <= H, `${d.key} is outside`);
  }
  assert.equal(
    dividers.filter((d) => d.axis === "x" && d.line === 2).length,
    real.length,
    "one grab area per real stretch",
  );
});

test("a boundary range is never inverted, so the lines stay in order", () => {
  // Two cards can ask for more room than the plane holds. The drag then has no
  // position that satisfies both, but it must not put a line past its
  // neighbour: that draws a card wider than one spanning more slots than it.
  const railed = () =>
    Soksak.from(
      {
        xs: [0, 0.12, 0.23, 1],
        ys: [0, 0.5, 1],
        cards: [
          { id: "A", c0: 0, c1: 1, r0: 0, r1: 1 },
          { id: "B", c0: 1, c1: 3, r0: 0, r1: 1 },
          { id: "C", c0: 0, c1: 2, r0: 1, r1: 2 },
          { id: "D", c0: 2, c1: 3, r0: 1, r1: 2 },
        ],
      },
      { width: 454, height: 400, gap: 24, minSize: 200 },
    );

  const [min, max] = railed().boundaryRange("x", 1);
  assert.ok(min <= max, `range is ${min}..${max}`);

  for (const move of [(g) => g.moveBoundary("x", 1, 300), (g) => g.centerBoundary("x", 1)]) {
    const grid = railed();
    move(grid);
    const xs = grid.lines("x");
    for (let k = 1; k < xs.length; k++) {
      assert.ok(xs[k] >= xs[k - 1], `lines out of order: ${xs.join(", ")}`);
    }
    assert.ok(grid.rect("C").w >= grid.rect("A").w - 1e-9, "C spans more slots than A");
  }
});

test("a drag never writes a line past its neighbour", () => {
  // The px to span conversion divides by one average slope, and the slots do
  // not all sit on it once a px size is in play, so the answer can land beyond
  // a neighbouring line.
  const grid = new Soksak(undefined, { width: 1600, height: 1000, gap: 24, minSize: 96 });
  grid.split("card", "x", { id: "n1" });
  grid.insertAt("x", 1, { size: 315, id: "n4" });
  grid.centerBoundary("x", 1);
  grid.split("n1", "y", { id: "n5" });
  grid.splitToward("n5", "left", { id: "n6" });
  grid.close("n6");
  grid.resize(588, 552);

  grid.moveBoundary("x", 3, 583);
  const xs = grid.lines("x");
  for (let k = 1; k < xs.length; k++) assert.ok(xs[k] >= xs[k - 1], `out of order: ${xs.join(", ")}`);
  assert.ok(xs.every((v) => v >= 0 && v <= 1), `outside 0..1: ${xs.join(", ")}`);
});

test("a grab area is centred on the boundary it grabs", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 600, gap: 24, grabSize: 11 });
  grid.split("card", "x");
  grid.split("card", "y");

  for (const d of grid.dividers()) {
    const at = grid.boundaryPos(d.axis, d.line);
    const thick = d.axis === "x" ? d.w : d.h;
    const near = d.axis === "x" ? d.x : d.y;
    assert.equal(thick, Math.max(grid.gap, 11), `${d.key} is as thick as the corridor`);
    // Centred: the pointer must be able to reach the boundary from either side
    // by the same distance.
    assert.ok(Math.abs(near + thick / 2 - at) < 1e-9, `${d.key} sits at ${near}, not around ${at}`);
  }
});

test("a rule covers exactly where cards break on the line", () => {
  // Two cards above the line and one below it, so only part of the line is a
  // boundary. The solid stretch must be the overlap of the two sides, not the
  // union: the wrong end would draw a rule where nothing meets.
  const grid = new Soksak(
    { xs: [0, 0.5, 1], ys: [0, 0.5, 1], cards: [
      { id: "topLeft", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "topRight", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "under", c0: 0, c1: 2, r0: 1, r1: 2 },
    ] },
    { width: 1200, height: 600, gap: 24 },
  );
  const solid = grid.rules().filter((r) => !r.virtual && r.axis === "x");
  assert.equal(solid.length, 1, "one stretch on x");
  const [stretch] = solid;
  const top = grid.rect("topLeft");
  // It reaches half a corridor past the pair at each end, and stops at the
  // plane rather than running off it.
  assert.equal(stretch.y, Math.max(0, top.y - grid.gap / 2), "it starts where the pair starts");
  assert.ok(
    Math.abs(stretch.y + stretch.h - (top.y + top.h + grid.gap / 2)) < 1e-9,
    "and ends where they stop meeting, not where the plane does",
  );
  assert.ok(stretch.h < grid.height, "so it is shorter than the whole line");
});

test("no two rules and no two grab areas share a key", () => {
  // The view keys its elements by these, so a repeated key means two rules
  // fighting over one element and one of them never drawn.
  for (let seed = 0; seed < 40; seed++) {
    const grid = three({ gap: seed % 30, minSize: seed % 60 });
    fuzz(grid, seed, 30);
    for (const [what, list] of [["rules", grid.rules()], ["dividers", grid.dividers()]]) {
      const keys = list.map((r) => r.key);
      assert.equal(new Set(keys).size, keys.length, `seed ${seed}: ${what} repeat a key`);
    }
    // And a solid stretch never runs past the line's own full-plane rule.
    for (const rule of grid.rules().filter((r) => !r.virtual)) {
      const full = grid.rules().find((r) => r.virtual && r.axis === rule.axis && r.line === rule.line);
      assert.ok(full, `seed ${seed}: ${rule.key} has a full-plane rule`);
      assert.ok(rule.h <= full.h + 1e-9 && rule.w <= full.w + 1e-9, `${rule.key} is longer than its line`);
    }
  }
});

/**
 * Lines that stand at one place. A drag or a close can leave two lines at the
 * same coordinate, with an empty slot between them. What the cards either side
 * of that run are owed does not change: a corridor is one gap wide.
 */
test("a card reaching over coincident lines keeps a full gap either side", () => {
  // `over` spans the empty slot. The plane is too small to give it width, so
  // it is drawn with none — but `held` and `far` still stand a gap away from
  // it, not the half gap the run charges when it is read as a single slot.
  const grid = new Soksak(
    {
      xs: [0, 0.3, 0.45, 0.5, 0.5, 1],
      ys: [0, 1],
      cards: [
        { id: "share", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "held", c0: 1, c1: 2, r0: 0, r1: 1, width: 100 },
        { id: "over", c0: 2, c1: 4, r0: 0, r1: 1 },
        { id: "far", c0: 4, c1: 5, r0: 0, r1: 1, width: 100 },
      ],
    },
    { width: 400, height: 300, gap: 24, minSize: 96 },
  );
  const held = grid.rect("held");
  const over = grid.rect("over");
  const far = grid.rect("far");
  assert.ok(over.w >= 0, `over is inside out at ${over.w}`);
  assert.ok(Math.abs(over.x - (held.x + held.w) - grid.gap) < 0.01, `${over.x - (held.x + held.w)} before it`);
  assert.ok(Math.abs(far.x - (over.x + over.w) - grid.gap) < 0.01, `${far.x - (over.x + over.w)} after it`);
});

test("a card between coincident lines is drawn with nothing where they stand", () => {
  // `flat` has both its lines at one place. It has no width to draw and no
  // corridor of its own; it sits at that place, inside the one gap that keeps
  // its neighbours apart.
  const grid = new Soksak(
    {
      xs: [0, 0.4, 0.7, 0.7, 1],
      ys: [0, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
        { id: "flat", c0: 2, c1: 3, r0: 0, r1: 1 },
        { id: "c", c0: 3, c1: 4, r0: 0, r1: 1 },
      ],
    },
    { width: 1600, height: 300, gap: 24, minSize: 96 },
  );
  const b = grid.rect("b");
  const flat = grid.rect("flat");
  const c = grid.rect("c");
  assert.equal(flat.w, 0, "it has nothing to draw");
  assert.equal(flat.x, grid.boundaryPos("x", 2), "and stands where its lines do");
  assert.ok(Math.abs(c.x - (b.x + b.w) - grid.gap) < 0.01, `its neighbours are ${c.x - (b.x + b.w)} apart`);
});

test("a px size on a slot with no span is still drawn at that size", () => {
  // The slot takes no share, so its width is the size the card declares and
  // the corridor on top. Reading the slot as empty drew the card a gap short.
  const grid = new Soksak(
    {
      xs: [0, 0.5, 0.5, 1],
      ys: [0, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "z", c0: 1, c1: 2, r0: 0, r1: 1, width: 100 },
        { id: "b", c0: 2, c1: 3, r0: 0, r1: 1 },
      ],
    },
    { width: 1600, height: 400, gap: 24, minSize: 96 },
  );
  const a = grid.rect("a");
  const z = grid.rect("z");
  const b = grid.rect("b");
  assert.equal(z.w, 100, "the size it was given");
  assert.ok(Math.abs(z.x - (a.x + a.w) - grid.gap) < 0.01);
  assert.ok(Math.abs(b.x - (z.x + z.w) - grid.gap) < 0.01);
});

test("insertAt refuses a size the plane cannot hold", () => {
  // Taking the whole plane leaves the cards already there none of it, and the
  // new line has to be written before the plane starts to make the room.
  const grid = three();
  const lines = grid.lines("x").length;
  assert.equal(grid.insertAt("x", 1, { size: W, id: "whole" }), null);
  assert.equal(grid.insertAt("x", 1, { size: W + 1, id: "past" }), null);
  assert.equal(grid.lines("x").length, lines, "and nothing was written");
  assert.ok(grid.lines("x").every((v) => v >= 0 && v <= 1), "the lines stay inside the plane");
  assert.ok(grid.insertAt("x", 1, { size: 200, id: "fits" }) !== null, "one that fits is taken");
});

test("a card with no width sits inside the corridor, not beside it", () => {
  // Its own two lines stand at one coordinate, so it is drawn at that
  // coordinate with nothing. The two cards that do have width are still a full
  // gap apart: the empty one is inside that gap, not another thing in the row.
  const grid = new Soksak(
    { xs: [0, 0.591717, 0.665638, 0.665638, 1], ys: [0, 1], cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "none", c0: 2, c1: 3, r0: 0, r1: 1 },
      { id: "c", c0: 3, c1: 4, r0: 0, r1: 1 },
    ] },
    { width: 1602, height: 600, gap: 24, minSize: 0 },
  );
  assert.equal(grid.rect("none").w, 0, "its two lines are at one coordinate");

  const drawn = [...grid.rects()].filter(([, r]) => r.w > 0).sort((x, y) => x[1].x - y[1].x);
  for (let i = 1; i < drawn.length; i++) {
    const [before, a] = drawn[i - 1];
    const [after, b] = drawn[i];
    assert.ok(
      Math.abs(b.x - (a.x + a.w) - grid.gap) < 1e-9,
      `${before} to ${after} is ${b.x - (a.x + a.w)}, not ${grid.gap}`,
    );
  }
  const none = grid.rect("none");
  const b = grid.rect("b");
  const c = grid.rect("c");
  assert.ok(none.x > b.x + b.w && none.x < c.x, "and the empty one is between them");
});

test("merging onto the plane's own border keeps the border", () => {
  // Two lines at the plane's edge: the border and one a drag brought onto it.
  // Folding them must drop the interior one. Dropping the border promoted a
  // coordinate a rounding short of the edge, and the plane came out
  // 0.9999999999999999 wide from then on.
  // The interior line stands a rounding short of the edge, the way arithmetic
  // leaves it. Folding must keep the border's exact 1, not promote this.
  const almost = 0.9999999999999999;
  assert.notEqual(almost, 1, "the fixture carries the rounding");
  const grid = new Soksak(
    { xs: [0, 0.2, 0.4, almost, 1], ys: [0, 1], cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "c", c0: 2, c1: 4, r0: 0, r1: 1 },
    ] },
    { width: 900, height: 600, gap: 12 },
  );
  const last = grid.lines("x").length - 1;
  assert.equal(grid.mergeCoincident("x", last), true, "the pair folds");

  const xs = grid.lines("x");
  assert.equal(xs[0], 0, "it still starts at 0");
  assert.equal(xs[xs.length - 1], 1, "and ends at 1, exactly");
  assert.equal(xs.length, 4, "one line went");
  assert.equal(grid.rect("c").x + grid.rect("c").w, 900, "so the last card reaches the edge");
  assertTiling(grid, "after folding onto the border");

  // The same from the other end.
  const left = new Soksak(
    { xs: [0, Number.MIN_VALUE, 0.6, 1], ys: [0, 1], cards: [
      { id: "a", c0: 0, c1: 2, r0: 0, r1: 1 },
      { id: "b", c0: 2, c1: 3, r0: 0, r1: 1 },
    ] },
    { width: 900, height: 600, gap: 12 },
  );
  assert.equal(left.mergeCoincident("x", 0), true);
  assert.equal(left.lines("x")[0], 0, "it still starts at 0, exactly");
  assert.equal(left.rect("a").x, 0, "so the first card starts at the edge");
});

test("split keeps the line array in order, so the state it writes reads back", () => {
  // The scan that places the new line accepts one EPS past the cut, and this
  // sequence puts the cut that far below the line before it.
  const grid = new Soksak(undefined, {
    width: 1081, height: 889, gap: 24, minSize: 1, snap: "merge", fillOrder: "h",
  });
  grid.split("card", "y", { id: "n0" });
  grid.move("n0", "card", "left");
  grid.setSize("n0", "y", 355);
  grid.split("n0", "y", { id: "n6" });
  grid.insertAt("y", 2, { size: 347, id: "n7" });
  grid.splitToward("n7", "bottom", { id: "n9" });
  grid.split("n0", "y", { id: "n10" });
  grid.split("n0", "y", { id: "n11" });
  grid.resize(338, 231);
  grid.splitToward("n9", "top", { id: "n12" });
  grid.close("n6");
  grid.splitToward("card", "right", { id: "n14" });
  grid.split("n14", "y", { id: "n17" });

  const ys = grid.lines("y");
  for (let k = 1; k < ys.length; k++) {
    assert.ok(ys[k] >= ys[k - 1], `ys[${k}] ${ys[k]} is before ys[${k - 1}] ${ys[k - 1]}`);
  }
  assert.doesNotThrow(() => grid.replace(grid.toJSON()), "the state it writes is one it accepts");
});

test("a line no card reads does not change where the cards are drawn", () => {
  const grid = new Soksak(undefined, {
    width: 1300, height: 693, gap: 30, minSize: 118, snap: "off", fillOrder: "h",
  });
  grid.splitToward("card", "left", { id: "n0" });
  grid.splitToward("n0", "right", { id: "n1" });
  grid.close("card");
  grid.insertAt("x", 0, { size: 294, id: "n4" });
  assert.equal(grid.isVirtual("x", 3), true, "line 3 is read by no card");

  const before = [...grid.cards].map((c) => ({ id: c.id, ...grid.rect(c.id) }));
  grid.tidy();
  for (const was of before) {
    const now = grid.rect(was.id);
    assert.ok(
      Math.abs(now.x - was.x) < 0.01 && Math.abs(now.w - was.w) < 0.01,
      `${was.id} moved from ${was.x}/${was.w} to ${now.x}/${now.w} when the line was removed`,
    );
  }
});

test("boundaryRange refuses a line that carries no boundary", () => {
  const grid = new Soksak(undefined, { width: 800, height: 600 });
  grid.split("card", "x");
  for (const line of [99, -5, 1.5, 0, 2]) {
    assert.deepEqual(grid.boundaryRange("x", line), [0, 0], `line ${line}`);
  }
  const [min, max] = grid.boundaryRange("x", 1);
  assert.ok(max > min, "and answers for one that does");
});

test("a drag snaps only when snapping is on and the caller allows it", () => {
  // `wide` spans lines 1 to 3, so line 2 is read by no card and a drag of line 1
  // that comes within snapDistance of it snaps onto it.
  const build = (snap) =>
    new Soksak(
      {
        xs: [0, 0.5, 0.75, 1],
        ys: [0, 1],
        cards: [
          { id: "narrow", c0: 0, c1: 1, r0: 0, r1: 1 },
          { id: "wide", c0: 1, c1: 3, r0: 0, r1: 1 },
        ],
      },
      { width: 1200, height: 800, gap: 24, minSize: 50, snap, snapDistance: 12 },
    );
  const drag = (snap, allowSnap) => {
    const grid = build(snap);
    const next = grid.lines("x")[2] * grid.width;
    return grid.moveBoundary("x", 1, next - 3, allowSnap);
  };

  const snapped = drag("merge", true);
  const off = drag("off", true);
  const refused = drag("merge", false);
  assert.ok(
    Math.abs(snapped - off) > 1,
    `snapping takes the boundary past what the drag asked, ${snapped} against ${off}`,
  );
  assert.equal(refused, off, "a drag that refuses the snap lands where snapping off lands");
});

test("the state a resize writes is one the library accepts", () => {
  // The last slot has almost no span, so the coordinates the rewrite accumulates
  // can pass the border it restores by one rounding.
  const grid = new Soksak(
    {
      xs: [0, 0.09123679935012186, 0.1922217709179529, 0.7847345858406022, 1, 1],
      ys: [0, 0.901174168297456, 0.9564579256360078, 1],
      cards: [
        { id: "card", c0: 0, c1: 5, r0: 0, r1: 1, fixed: true },
        { id: "card-3", c0: 2, c1: 5, r0: 2, r1: 3 },
        { id: "card-7", c0: 0, c1: 2, r0: 1, r1: 3 },
        { id: "card-4", c0: 2, c1: 5, r0: 1, r1: 2 },
      ],
    },
    { width: 1231, height: 712, gap: 24, minSize: 0 },
  );
  grid.insertAt("x", 0, { size: 158 });

  const xs = grid.lines("x");
  for (let k = 1; k < xs.length; k++) {
    assert.ok(xs[k] >= xs[k - 1], `xs[${k}] ${xs[k]} is before xs[${k - 1}] ${xs[k - 1]}`);
  }
  assert.doesNotThrow(() => grid.replace(grid.toJSON()), "the state it writes is one it accepts");
});

test("a slot stopped at its corridor does not bend a drag", () => {
  // `c` has no span to flex with, so it is drawn at the corridor it holds and
  // the px a unit of span is worth comes from the slots that do flex.
  const build = () =>
    new Soksak(
      {
        xs: [0, 1],
        ys: [0, 0.2, 0.6, 0.75, 1],
        cards: [
          { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
          { id: "b", c0: 0, c1: 1, r0: 1, r1: 2 },
          { id: "c", c0: 0, c1: 1, r0: 2, r1: 3 },
          { id: "d", c0: 0, c1: 1, r0: 3, r1: 4, height: 250 },
        ],
      },
      { width: 400, height: 350, gap: 24, minSize: 0 },
    );

  const moved = build();
  const at = moved.moveBoundary("y", 1, 26, false);
  assert.ok(Math.abs(at - 26) < 0.01, `the boundary reaches 26, not ${at}`);

  const centred = build();
  centred.centerBoundary("y", 1);
  assert.ok(
    Math.abs(centred.rect("a").h - centred.rect("b").h) < 0.02,
    `the two cards come out the same size, not ${centred.rect("a").h} and ${centred.rect("b").h}`,
  );
});

test("a drag lands where it asked while a slot is stopped at its corridor", () => {
  // The slot the starvation rule stopped does not flex with its span, and it
  // flexes again as soon as the move gives it room, so one conversion of px into
  // span lands short. The plane holds what this axis declares before and after.
  const state = {
    xs: [0, 0.20150587381823687, 0.608, 0.624, 0.64, 0.7840677966101695, 1],
    ys: [0, 0.25604838709677413, 0.2560483870967742, 1],
    cards: [
      { id: "card-1", c0: 0, c1: 2, r0: 0, r1: 1 },
      { id: "card-9", c0: 0, c1: 2, r0: 1, r1: 3 },
      { id: "card-10", c0: 2, c1: 4, r0: 0, r1: 3 },
      { id: "card-11", c0: 5, c1: 6, r0: 0, r1: 3, width: 180 },
      { id: "card-12", c0: 4, c1: 5, r0: 0, r1: 3, width: 85 },
    ],
  };
  for (const ask of [115, 130.57, 160]) {
    const grid = new Soksak(state, { width: 590, height: 531, gap: 24, minSize: 96 });
    const at = grid.moveBoundary("x", 2, ask, false);
    assert.ok(Math.abs(at - ask) < 0.01, `the boundary reaches ${ask}, not ${at}`);
  }
});

test("the range takes in where the boundary stands, so a drag that does not move it moves nothing", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 600, gap: 24, minSize: 96 });
  grid.split("card", "x");
  grid.split("card", "x");
  grid.resize(420, 600);                       // too small for three cards at 96
  for (const line of [1, 2]) {
    const at = grid.boundaryPos("x", line);
    const [min, max] = grid.boundaryRange("x", line);
    assert.ok(min <= at && at <= max, `line ${line}: ${at} outside [${min}, ${max}]`);
  }
  const was = grid.rects();
  const at = grid.boundaryPos("x", 1);
  assert.equal(grid.moveBoundary("x", 1, at, false), at);
  assert.deepEqual(grid.rects(), was);
});

test("centring halves the two cards, not the two lines beside them", () => {
  const grid = new Soksak(
    {
      xs: [0, 0.5, 1],
      ys: [0, 0.5, 0.75, 1],
      cards: [
        { id: "top", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "bottom", c0: 0, c1: 1, r0: 1, r1: 3 },   // reaches past line 2
        { id: "r-top", c0: 1, c1: 2, r0: 0, r1: 2 },
        { id: "r-bottom", c0: 1, c1: 2, r0: 2, r1: 3 },
      ],
    },
    { width: 800, height: 600, gap: 24, minSize: 40 },
  );
  grid.centerBoundary("y", 1);
  assert.equal(grid.rect("top").h, grid.rect("bottom").h);
});

test("a drag on an axis where nothing flexes leaves the line where it stands", () => {
  // Every sharing slot is stopped at the corridor it holds, so no span buys a
  // px and the boundary reports one position. A drag must leave it there rather
  // than fold it onto the line before it.
  const grid = new Soksak(
    { xs: [0, 1 / 3, 2 / 3, 1], ys: [0, 1], cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "c", c0: 2, c1: 3, r0: 0, r1: 1 },
    ] },
    { width: 100, height: 100, gap: 50, minSize: 1 },
  );
  const at = grid.boundaryPos("x", 1);
  assert.deepEqual(grid.boundaryRange("x", 1), [at, at], "the boundary cannot move");
  const was = grid.lines("x");
  assert.equal(grid.moveBoundary("x", 1, at, false), at, "a drag that asks for where it is");
  assert.deepEqual(grid.lines("x"), was);
  assert.equal(grid.moveBoundary("x", 1, at + 40, false), at, "and one that asks for more");
  assert.deepEqual(grid.lines("x"), was);
});

test("a grab area over a run of coincident lines has no length, not a negative one", () => {
  const grid = new Soksak(
    { xs: [0, 0.5, 1], ys: [0, 0.4, 0.4, 1], cards: [
      { id: "top", c0: 0, c1: 2, r0: 0, r1: 1 },
      { id: "thinL", c0: 0, c1: 1, r0: 1, r1: 2 },
      { id: "thinR", c0: 1, c1: 2, r0: 1, r1: 2 },
      { id: "bottom", c0: 0, c1: 2, r0: 2, r1: 3 },
    ] },
    { width: 600, height: 400, gap: 24, minSize: 0 },
  );
  for (const d of grid.dividers()) {
    assert.ok(d.w >= 0 && d.h >= 0, `${d.key} is ${d.w}x${d.h}`);
  }
});

test("centring measures again from where the boundary landed", () => {
  // `wide` declares more width than the plane can give, so every declared size is
  // drawn scaled and each move changes that scale. One conversion of the middle
  // into a move lands short of it.
  const grid = new Soksak(
    {
      xs: [0, 0.5, 0.75, 0.777542372881356, 1],
      ys: [0, 1],
      cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "wide", c0: 1, c1: 2, r0: 0, r1: 1, width: 296 },
        { id: "b", c0: 2, c1: 3, r0: 0, r1: 1 },
        { id: "c", c0: 3, c1: 4, r0: 0, r1: 1 },
      ],
    },
    { width: 472, height: 324, gap: 10, minSize: 3 },
  );
  grid.centerBoundary("x", 3);
  assert.ok(
    Math.abs(grid.rect("b").w - grid.rect("c").w) < 0.01,
    `the two cards come out the same size, not ${grid.rect("b").w} and ${grid.rect("c").w}`,
  );
});
