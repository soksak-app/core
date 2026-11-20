import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, fuzz, H, three, W } from "./helpers.mjs";

test("dragging a line moves every card referencing it", () => {
  const grid = three();
  grid.split("upper", "x");
  grid.split("lower", "x");
  const before = ["upper", "lower"].map((id) => grid.rect(id).w);
  grid.moveBoundary("x", 2, 0.5 * W);
  const after = ["upper", "lower"].map((id) => grid.rect(id).w);
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

test("centring makes the two cards beside a line the same size", () => {
  const grid = three();
  grid.moveBoundary("x", 1, 0.12 * W);
  grid.centerBoundary("x", 1);
  const a = grid.rect("sidebar");
  const b = grid.rect("upper");
  assert.ok(Math.abs(a.w - b.w) < 0.01, `${a.w} vs ${b.w}`);

  grid.centerBoundary("y", 1);
  const top = grid.rect("upper");
  const bottom = grid.rect("lower");
  assert.ok(Math.abs(top.h - bottom.h) < 0.01, `${top.h} vs ${bottom.h}`);
  assertTiling(grid, "after centring");
});

test("dividers cover referenced lines; rules cover every line", () => {
  const grid = three();
  grid.split("upper", "x");
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
  // position that satisfies both. The seam of the upper row moves within its own
  // row: the seam of the lower row is a line of another cut and no limit.
  const railed = () =>
    Soksak.from(
      { root: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.12, node: { card: "A" } }, { share: 0.88, node: { card: "B" } }] } }, { share: 0.5, node: { cut: "x", kids: [{ share: 0.23, node: { card: "C" } }, { share: 0.77, node: { card: "D" } }] } }] } },
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
    assert.ok(Math.abs(grid.rect("C").w - railed().rect("C").w) < 1e-9, "the lower row keeps its seam");
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
    { root: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "topLeft" } }, { share: 0.5, node: { card: "topRight" } }] } }, { share: 0.5, node: { card: "under" } }] } },
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
    { root: { cut: "x", kids: [{ share: 0.3, node: { card: "share" } }, { share: 0.15000000000000002, node: { card: "held", width: 100 } }, { share: 0.04999999999999999, node: { card: "over" } }, { share: 0.5, node: { card: "far", width: 100 } }] } },
    { width: 400, height: 300, gap: 24, minSize: 96 },
  );
  const held = grid.rect("held");
  const over = grid.rect("over");
  const far = grid.rect("far");
  assert.ok(over.w >= 0, `over is inside out at ${over.w}`);
  assert.ok(Math.abs(over.x - (held.x + held.w) - grid.gap) < 0.01, `${over.x - (held.x + held.w)} before it`);
  assert.ok(Math.abs(far.x - (over.x + over.w) - grid.gap) < 0.01, `${far.x - (over.x + over.w)} after it`);
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
  // The top row's seam is line 1 at half the plane. The bottom row's seam is
  // line 2, a little further right, so a drag of line 1 that comes within
  // snapDistance of line 2 snaps onto it.
  const build = (snap) =>
    new Soksak(
      { root: { cut: "y", kids: [
        { share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "narrow" } }, { share: 0.5, node: { card: "wide" } }] } },
        { share: 0.5, node: { cut: "x", kids: [{ share: 0.7, node: { card: "p" } }, { share: 0.3, node: { card: "q" } }] } },
      ] } },
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
    { root: { cut: "y", kids: [{ share: 0.901174168297456, node: { card: "card", fixed: true } }, { share: 0.098825831702544, node: { cut: "x", kids: [{ share: 0.1922217709179529, node: { card: "card-7" } }, { share: 0.8077782290820471, node: { cut: "y", kids: [{ share: 0.5594059405940595, node: { card: "card-4" } }, { share: 0.4405940594059406, node: { card: "card-3" } }] } }] } }] } },
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
      { root: { cut: "y", kids: [{ share: 0.2, node: { card: "a" } }, { share: 0.39999999999999997, node: { card: "b" } }, { share: 0.15000000000000002, node: { card: "c" } }, { share: 0.25, node: { card: "d", height: 250 } }] } },
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

test("a seam beside two kids drawn at their minimum or below holds where it stands", () => {
  // card-10 is drawn below `minSize` because the plane is too small, and card-12
  // declares 85, below it as well. Neither kid of the cut can give room, so the
  // range is the position the seam stands at and a drag moves nothing.
  const state = { root: { cut: "x", kids: [{ share: 0.608, node: { cut: "y", kids: [{ share: 0.25604838709677413, node: { card: "card-1" } }, { share: 0.7439516129032259, node: { card: "card-9" } }] } }, { share: 0.03200000000000003, node: { card: "card-10" } }, { share: 0.14406779661016944, node: { card: "card-12", width: 85 } }, { share: 0.21593220338983055, node: { card: "card-11", width: 180 } }] } };
  for (const ask of [295, 310, 325]) {
    const grid = new Soksak(state, { width: 590, height: 531, gap: 24, minSize: 96 });
    const at = grid.boundaryPos("x", 2);
    const was = grid.rects();
    assert.deepEqual(grid.boundaryRange("x", 2), [at, at]);
    assert.equal(grid.moveBoundary("x", 2, ask, false), at, `the ask ${ask} moves nothing`);
    assert.deepEqual(grid.rects(), was);
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
    { root: { cut: "x", kids: [{ share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "top" } }, { share: 0.5, node: { card: "bottom" } }] } }, { share: 0.5, node: { cut: "y", kids: [{ share: 0.75, node: { card: "r-top" } }, { share: 0.25, node: { card: "r-bottom" } }] } }] } },
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
    { root: { cut: "x", kids: [{ share: 0.3333333333333333, node: { card: "a" } }, { share: 0.3333333333333333, node: { card: "b" } }, { share: 0.33333333333333337, node: { card: "c" } }] } },
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

test("centring measures again from where the boundary landed", () => {
  // `wide` declares more width than the plane can give, so every declared size is
  // drawn scaled and each move changes that scale. One conversion of the middle
  // into a move lands short of it.
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.25, node: { card: "wide", width: 296 } }, { share: 0.02754237288135597, node: { card: "b" } }, { share: 0.22245762711864403, node: { card: "c" } }] } },
    { width: 472, height: 324, gap: 10, minSize: 3 },
  );
  grid.centerBoundary("x", 3);
  assert.ok(
    Math.abs(grid.rect("b").w - grid.rect("c").w) < 0.01,
    `the two cards come out the same size, not ${grid.rect("b").w} and ${grid.rect("c").w}`,
  );
});

test("a drag never leaves the boundary further from the target than it stood", () => {
  // A plane too narrow for what it holds: the cut of four cards cannot hold its
  // corridors, so its cards are drawn with no width, and the lines beside them
  // have no room. A drag toward either end of the range of each line lands no
  // further from where it was asked than where it stood.
  const grid = new Soksak(undefined, { width: 800, height: 300, gap: 21, minSize: 8 });
  for (const [id, axis, born] of [
    ["card", "x", "c0"],
    ["card", "y", "c1"],
    ["c1", "x", "c2"],
    ["c1", "x", "c3"],
    ["c3", "x", "c4"],
    ["c0", "y", "c5"],
  ]) {
    assert.equal(grid.split(id, axis, { id: born }), born);
  }
  grid.setSize("c2", "y", 196);
  grid.resize(140, 300);

  let moved = 0;
  const start = grid.toJSON();
  for (let line = 1; line < grid.lines("x").length - 1; line++) {
    for (const end of [0, 1]) {
      grid.replace(start);
      const from = grid.boundaryPos("x", line);
      const range = grid.boundaryRange("x", line);
      const asked = range[end];
      const to = grid.moveBoundary("x", line, asked, false);
      assert.ok(Math.abs(to - asked) <= Math.abs(from - asked) + 1e-9, `line ${line}: asked ${asked}, stood at ${from}, landed ${to}`);
      assert.ok(to >= range[0] - 0.01 && to <= range[1] + 0.01, `line ${line}: landed ${to}, outside the range ${range}`);
      if (Math.abs(to - from) > 1) moved++;
    }
  }
  assert.ok(moved > 0, "a line with room moved");
});

test("a split with newLine cuts the card as its own cut, drawing the line the other row holds", () => {
  const state = () => ({ root: { cut: "y", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "b" } }, { share: 0.5, node: { card: "c" } }] } }] } });
  const taken = new Soksak(state(), { width: 1000, height: 1000, gap: 0 });
  assert.notEqual(taken.split("a", "x", { id: "n" }), null);
  assert.equal(taken.lines("x").length, 3, "the plain split takes the line that a spans across");
  const fresh = new Soksak(state(), { width: 1000, height: 1000, gap: 0 });
  assert.notEqual(fresh.splitToward("a", "left", { id: "n", newLine: true }), null);
  assert.equal(fresh.lines("x").length, 3, "the new cut stands on the line the bottom row holds, so one line is drawn");
  assert.equal(fresh.card("n").c0, 0);
});


test("a boundary's range and its move come from its own cut, not from a line of another cut", () => {
  // The head of the group is a cost of its column, so the seam of the left column stands at 310 and the seam of the right
  // column at 300: two derived lines. The left seam stops where its upper card is drawn its minimum and its head.
  const state = { root: { cut: "x", kids: [
    { share: 0.5, node: { box: "g", inner: { cut: "y", kids: [{ share: 0.5, node: { card: "c1" } }, { share: 0.5, node: { card: "c2" } }] } } },
    { share: 0.5, node: { cut: "y", kids: [{ share: 0.5, node: { card: "c3" } }, { share: 0.5, node: { card: "c4" } }] } },
  ] } };
  const grid = new Soksak(state, { width: 1000, height: 600, gap: 24, minSize: 96 });
  grid.setHeads({ g: 44 });
  const line = grid.card("c1").r1;
  const other = { c3: grid.rect("c3"), c4: grid.rect("c4") };
  assert.notEqual(line, grid.card("c3").r1, "the two seams are two lines");
  assert.deepEqual(grid.boundaryRange("y", line), [96 + 44 + 12, 576 - 96 - 12], "the minimums of the two kids of the cut bound the range");
  // The kids take fractions, so the positions carry the rounding of a fraction of the rest.
  assert.ok(Math.abs(grid.moveBoundary("y", line, 0, false) - 152) < 1e-9);
  assert.ok(Math.abs(grid.rect("c1").h - (96 + 44)) < 1e-9, "the upper card is drawn its minimum and the head inside it");
  // The seam now stands before the seam of the other column, so it has another index.
  assert.ok(Math.abs(grid.moveBoundary("y", grid.card("c1").r1, 600, false) - 468) < 1e-9);
  assert.ok(Math.abs(grid.rect("c2").h - 96) < 1e-9, "the lower card is drawn its minimum");
  assert.deepEqual({ c3: grid.rect("c3"), c4: grid.rect("c4") }, other, "the seam of the other column stays");
});

test("the heads above a card or a box come from its last layout, and an id that is no card or box is refused", () => {
  const state = { root: { cut: "x", kids: [
    { share: 0.5, node: { box: "g", inner: { card: "c1" } } },
    { share: 0.5, node: { card: "c2" } },
  ] } };
  const grid = new Soksak(state, { width: 1000, height: 600, gap: 24, minSize: 96 });
  grid.setHeads({ g: 44 });
  assert.equal(grid.headsAbove("c1"), 44, "the head of the group is drawn inside the top of its card");
  assert.equal(grid.headsAbove("c2"), 0, "a card that no box surrounds has no heads above it");
  assert.throws(() => grid.headsAbove("none"), /soksak: "none" is no card or box of the grid/);
});
