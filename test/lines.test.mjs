import assert from "node:assert/strict";
import test from "node:test";

import { assertTiling, H, three, W, withFreePair } from "./helpers.mjs";

test("dragging a line moves every card that reads it", () => {
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

test("a line stops where a card would fall under minSize", () => {
  const grid = three();
  grid.moveBoundary("x", 1, -5 * W);
  assertTiling(grid, "pushed to the start");
  grid.moveBoundary("x", 1, 5 * W);
  assertTiling(grid, "pushed to the end");
});

test("a line may travel all the way onto its neighbour", () => {
  const { grid, line } = withFreePair({ snap: "off" });
  const target = grid.boundaryPos("x", line + 1);
  grid.moveBoundary("x", line, W);
  assert.equal(grid.boundaryPos("x", line), target, "it reaches the neighbour exactly");
  assertTiling(grid, "with two lines on the same coordinate");
});

test("snap pulls a line the last few pixels onto its neighbour", () => {
  const near = withFreePair({ snap: "merge", snapDistance: 7 });
  const target = near.grid.boundaryPos("x", near.line + 1);
  near.grid.moveBoundary("x", near.line, target - 5);
  assert.equal(near.grid.boundaryPos("x", near.line), target, "snapped");

  const far = withFreePair({ snap: "merge", snapDistance: 7 });
  const target2 = far.grid.boundaryPos("x", far.line + 1);
  far.grid.moveBoundary("x", far.line, target2 - 60);
  assert.notEqual(far.grid.boundaryPos("x", far.line), target2, "60px away is left alone");

  const off = withFreePair({ snap: "off" });
  const target3 = off.grid.boundaryPos("x", off.line + 1);
  off.grid.moveBoundary("x", off.line, target3 - 5);
  assert.notEqual(off.grid.boundaryPos("x", off.line), target3, "snap off leaves it alone");
});

test("coincident lines merge into one, and never at the cost of a card", () => {
  const { grid, line } = withFreePair({ snap: "merge" });
  const lines = grid.lines("x").length;
  const cards = grid.cards.length;

  grid.moveBoundary("x", line, W);
  assert.equal(grid.mergeCoincident("x", line), true);
  assert.equal(grid.lines("x").length, lines - 1);
  assert.equal(grid.cards.length, cards, "no card was lost");
  assertTiling(grid, "after merging two lines");
});

test("merge is refused when snap is off", () => {
  const { grid, line } = withFreePair({ snap: "off" });
  const lines = grid.lines("x").length;
  grid.moveBoundary("x", line, W);
  assert.equal(grid.mergeCoincident("x", line), false);
  assert.equal(grid.lines("x").length, lines);
});

test("centring a line makes the two cards beside it the same size", () => {
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

test("a line no card reads is virtual, survives a close, and can be tidied", () => {
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

test("only real boundaries get a grab area; every line gets a drawn rule", () => {
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
  assert.equal(virtual[0].h, H + grid.gap, "it spans the whole plane");
  assert.ok(real.length >= 1);
  assert.ok(real.every((r) => r.h < virtual[0].h), "real stretches are shorter");
  assert.equal(
    dividers.filter((d) => d.axis === "x" && d.line === 2).length,
    real.length,
    "one grab area per real stretch",
  );
});
