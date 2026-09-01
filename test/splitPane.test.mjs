import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, W, make, three } from "./helpers.mjs";

test("a fresh soksak is one pane filling the plane", () => {
  const grid = make();
  assert.equal(grid.panes.length, 1);
  const rect = grid.rect("pane");
  assert.deepEqual(
    { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    { x: 0, y: 0, w: W, h: H },
  );
  assertTiling(grid, "fresh");
});

test("panes that meet read the same line, so a boundary cannot drift", () => {
  const grid = three();
  const sidebar = grid.rect("sidebar");
  const terminal = grid.rect("terminal");
  assert.equal(sidebar.x + sidebar.w + grid.gap, terminal.x);
  grid.moveLine("x", 1, 0.5);
  const movedSidebar = grid.rect("sidebar");
  const movedTerminal = grid.rect("terminal");
  assert.equal(movedSidebar.x + movedSidebar.w + grid.gap, movedTerminal.x);
  assertTiling(grid, "after moving the shared line");
});

test("splitting keeps the original pane and its near half", () => {
  const grid = three();
  const before = grid.pane("terminal");
  const beforeRect = grid.rect("terminal");
  const id = grid.split("terminal", "x");

  assert.equal(grid.pane("terminal"), before, "the original object survives");
  assert.equal(grid.panes.length, 4);
  const after = grid.rect("terminal");
  assert.equal(after.x, beforeRect.x, "the original keeps the near edge");
  assert.ok(after.w < beforeRect.w);
  assert.ok(grid.rect(id).x > after.x, "the new pane takes the far half");
  assertTiling(grid, "after split");
});

test("a pane spanning the new line widens its span instead of being cut", () => {
  const grid = three();
  const before = grid.rect("browser");
  grid.split("terminal", "x");
  const after = grid.rect("browser");
  assert.deepEqual(
    { x: after.x, w: after.w },
    { x: before.x, w: before.w },
    "the pane below is untouched",
  );
  assert.equal(grid.crossings(grid.pane("browser")), 1, "it now spans one virtual line");
  assertTiling(grid, "with a straddling pane");
});

test("a later split snaps to the line another pane already made", () => {
  const grid = three();
  const first = grid.split("terminal", "x");
  const lines = grid.lines("x").length;
  grid.moveLine("x", 2, 0.75);
  const moved = grid.lines("x")[2];

  const second = grid.split("browser", "x");
  assert.equal(grid.lines("x").length, lines, "no new line was drawn");
  assert.equal(grid.lines("x")[2], moved, "the line did not move");
  assert.equal(grid.rect(first).x, grid.rect(second).x, "both new panes share the edge");
  assertTiling(grid, "after snapping to an existing line");
});

test("splitting is refused when a half would fall under minSize", () => {
  const grid = make({ minSize: 96, gap: 24 });
  let splits = 0;
  while (grid.canSplit(grid.panes[0].id, "y") && splits < 100) {
    grid.split(grid.panes[0].id, "y");
    splits++;
  }
  assert.ok(splits > 0 && splits < 100);
  assert.equal(grid.split(grid.panes[0].id, "y"), null, "an extra split is a no-op");
  assertTiling(grid, "at the smallest pane size");
});

test("canSplit is exactly 'two halves plus a corridor fit'", () => {
  const grid = three();
  for (const axis of ["x", "y"]) {
    for (const pane of grid.panes) {
      const rect = grid.rectOf(pane);
      const edge = axis === "x" ? rect.w : rect.h;
      const fits = !pane.fixed && edge >= 2 * grid.minSize + grid.gap - 0.01;
      assert.equal(grid.canSplit(pane.id, axis), fits, `${pane.id} ${axis}`);
    }
  }
});

test("a fixed pane is never split and never closed", () => {
  const grid = three();
  assert.equal(grid.canSplit("sidebar", "x"), false);
  assert.equal(grid.canSplit("sidebar", "y"), false);
  assert.equal(grid.canClose("sidebar"), false);
  assert.equal(grid.split("sidebar", "x"), null);
  assert.equal(grid.close("sidebar"), false);
});

test("state round-trips through JSON", () => {
  const grid = three();
  grid.split("terminal", "x");
  grid.moveLine("x", 2, 0.7);
  const copy = Soksak.from(grid.toJSON(), { width: W, height: H });
  assert.deepEqual(copy.toJSON(), grid.toJSON());
  for (const pane of grid.panes) {
    assert.deepEqual(copy.rect(pane.id), grid.rect(pane.id));
  }
});
