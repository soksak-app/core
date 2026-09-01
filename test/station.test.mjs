import assert from "node:assert/strict";
import test from "node:test";

import { assertTiling, H, three, W } from "./helpers.mjs";

test("a line is clean when no pane spans across it", () => {
  const grid = three();
  // sidebar | terminal over browser — the middle line is a boundary for everyone
  assert.deepEqual(grid.cleanLines("x"), [0, 1, 2]);

  grid.split("terminal", "x");
  // the new line only divides the top row; browser spans across it
  assert.equal(grid.isCleanLine("x", 2), false);
  assert.deepEqual(grid.cleanLines("x"), [0, 1, 3]);
  assert.deepEqual(
    grid.panesCrossing("x", 2).map((p) => p.id),
    ["browser"],
  );

  // split the pane that was in the way and the line becomes clean
  grid.split("browser", "x");
  assert.equal(grid.isCleanLine("x", 2), true);
  assert.deepEqual(grid.panesCrossing("x", 2), []);
});

test("cleanliness is structural, so a drag never changes it", () => {
  const grid = three();
  grid.split("terminal", "x");
  const before = grid.cleanLines("x");
  for (const value of [0.1, 0.35, 0.9]) grid.moveLine("x", 1, value);
  assert.deepEqual(grid.cleanLines("x"), before, "moving a line cannot make one clean or unclean");
});

test("the nearest clean line skips the ones a pane blocks", () => {
  const grid = three();
  grid.split("terminal", "x");
  const lines = grid.lines("x");
  // line 2 is blocked, so a position sitting right on it resolves elsewhere
  assert.notEqual(grid.nearestCleanLine("x", lines[2]), 2);
  assert.equal(grid.nearestCleanLine("x", 0), 0);
  assert.equal(grid.nearestCleanLine("x", 1), 3);
  assert.ok(grid.cleanLines("x").includes(grid.nearestCleanLine("x", lines[2])));
});

test("a band only stands on a clean line", () => {
  const grid = three();
  grid.split("terminal", "x");
  assert.equal(grid.setStation("x", 2, 200), false, "the blocked line is refused");
  assert.equal(grid.station, null);
  assert.equal(grid.setStation("x", 1, 200), true);
  assert.deepEqual(grid.station, { axis: "x", line: 1, size: 200 });
});

test("the band takes room and the panes keep the rest", () => {
  const grid = three();
  const before = grid.rects();
  const band = 200;
  assert.equal(grid.setStation("x", 1, band), true);
  const after = grid.rects();

  assert.ok(after.get("sidebar").w < before.get("sidebar").w, "the left side gives room");
  assert.ok(after.get("terminal").w < before.get("terminal").w, "so does the right");

  const rect = grid.stationRect();
  const left = after.get("sidebar");
  const right = after.get("terminal");
  assert.equal(rect.h, H, "a vertical band runs the full height");
  assert.ok(Math.abs(rect.w - (band - grid.gap)) < 0.01, "its drawn width is the room minus one corridor");
  assert.ok(
    Math.abs(rect.x - (left.x + left.w) - grid.gap) < 0.01,
    "one full corridor from the pane on its left",
  );
  assert.ok(
    Math.abs(right.x - (rect.x + rect.w) - grid.gap) < 0.01,
    "and one from the pane on its right",
  );
});

test("panes and the band together cover the plane exactly", () => {
  const grid = three();
  grid.setStation("x", 1, 180);
  const rects = [...grid.rects().values()];
  const band = grid.stationRect();
  // widths across the top row: sidebar | band | terminal, with a corridor between each
  const row = [rects.find((r) => r.x === 0), band, grid.rect("terminal")];
  const spanned = row.reduce((n, r) => n + r.w, 0) + grid.gap * 2;
  assert.ok(Math.abs(spanned - W) < 0.01, `${spanned} vs ${W}`);
});

test("clearing the band gives the room back exactly", () => {
  const grid = three();
  const before = JSON.stringify([...grid.rects()]);
  grid.setStation("x", 1, 240);
  grid.clearStation();
  assert.equal(JSON.stringify([...grid.rects()]), before);
  assert.equal(grid.stationRect(), null);
  assertTiling(grid, "after the band left");
});

test("the band survives splitting and dragging elsewhere", () => {
  const grid = three();
  grid.setStation("x", 1, 200);
  grid.split("terminal", "y");
  grid.moveLine("x", 1, 0.4);
  const band = grid.stationRect();
  const left = grid.rect("sidebar");
  assert.ok(Math.abs(band.x - (left.x + left.w) - grid.gap) < 0.01, "still one corridor from its neighbour");
  assert.equal(band.h, H);
});
