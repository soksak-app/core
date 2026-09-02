import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, fuzz, H, three, W } from "./helpers.mjs";

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
