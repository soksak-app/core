import assert from "node:assert/strict";
import test from "node:test";

import { assertTiling, H, three, W, withFreePair } from "./helpers.mjs";

test("dragging a line moves every pane that reads it", () => {
  const grid = three();
  grid.split("terminal", "x");
  grid.split("browser", "x");
  const before = ["terminal", "browser"].map((id) => grid.rect(id).w);
  grid.moveLine("x", 2, 0.5);
  const after = ["terminal", "browser"].map((id) => grid.rect(id).w);
  assert.ok(after[0] !== before[0]);
  assert.equal(after[0].toFixed(4), after[1].toFixed(4), "both follow the same line");
  assertTiling(grid, "after a shared drag");
});

test("a line stops where a pane would fall under minSize", () => {
  const grid = three();
  grid.moveLine("x", 1, -5);
  assertTiling(grid, "pushed to the start");
  grid.moveLine("x", 1, 5);
  assertTiling(grid, "pushed to the end");
});

test("a line may travel all the way onto its neighbour", () => {
  const { grid, line } = withFreePair({ snap: "off" });
  const target = grid.lines("x")[line + 1];
  grid.moveLine("x", line, 1);
  assert.equal(grid.lines("x")[line], target, "it reaches the neighbour exactly");
  assertTiling(grid, "with two lines on the same coordinate");
});

test("snap pulls a line the last few pixels onto its neighbour", () => {
  const near = withFreePair({ snap: "merge", snapDistance: 7 });
  const target = near.grid.lines("x")[near.line + 1];
  near.grid.moveLine("x", near.line, target - 5 / W);
  assert.equal(near.grid.lines("x")[near.line], target, "snapped");

  const far = withFreePair({ snap: "merge", snapDistance: 7 });
  const target2 = far.grid.lines("x")[far.line + 1];
  far.grid.moveLine("x", far.line, target2 - 60 / W);
  assert.notEqual(far.grid.lines("x")[far.line], target2, "60px away is left alone");

  const off = withFreePair({ snap: "off" });
  const target3 = off.grid.lines("x")[off.line + 1];
  off.grid.moveLine("x", off.line, target3 - 5 / W);
  assert.notEqual(off.grid.lines("x")[off.line], target3, "snap off leaves it alone");
});

test("coincident lines merge into one, and never at the cost of a pane", () => {
  const { grid, line } = withFreePair({ snap: "merge" });
  const lines = grid.lines("x").length;
  const panes = grid.panes.length;

  grid.moveLine("x", line, 1);
  assert.equal(grid.mergeCoincident("x", line), true);
  assert.equal(grid.lines("x").length, lines - 1);
  assert.equal(grid.panes.length, panes, "no pane was lost");
  assertTiling(grid, "after merging two lines");
});

test("merge is refused when snap is off", () => {
  const { grid, line } = withFreePair({ snap: "off" });
  const lines = grid.lines("x").length;
  grid.moveLine("x", line, 1);
  assert.equal(grid.mergeCoincident("x", line), false);
  assert.equal(grid.lines("x").length, lines);
});

test("centring a line makes the two panes beside it the same size", () => {
  const grid = three();
  grid.moveLine("x", 1, 0.12);
  grid.centerLine("x", 1);
  const a = grid.rect("sidebar");
  const b = grid.rect("terminal");
  assert.ok(Math.abs(a.w - b.w) < 0.01, `${a.w} vs ${b.w}`);

  grid.centerLine("y", 1);
  const top = grid.rect("terminal");
  const bottom = grid.rect("browser");
  assert.ok(Math.abs(top.h - bottom.h) < 0.01, `${top.h} vs ${bottom.h}`);
  assertTiling(grid, "after centring");
});

test("a line no pane reads is virtual, survives a close, and can be tidied", () => {
  const grid = three();
  grid.split("terminal", "y");
  grid.split("terminal", "y");
  assert.equal(grid.virtualCount(), 0);
  const lines = grid.lines("y").length;

  const spare = grid.panes.find((p) => p.id.startsWith("pane-"));
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
