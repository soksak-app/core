import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, W, make, three } from "./helpers.mjs";

test("a fresh soksak is one card filling the plane", () => {
  const grid = make();
  assert.equal(grid.cards.length, 1);
  const rect = grid.rect("card");
  assert.deepEqual(
    { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    { x: 0, y: 0, w: W, h: H },
  );
  assertTiling(grid, "fresh");
});

test("cards that meet read the same line, so a boundary cannot drift", () => {
  const grid = three();
  const sidebar = grid.rect("sidebar");
  const terminal = grid.rect("terminal");
  assert.equal(sidebar.x + sidebar.w + grid.gap, terminal.x);
  grid.moveBoundary("x", 1, 0.5 * W);
  const movedSidebar = grid.rect("sidebar");
  const movedTerminal = grid.rect("terminal");
  assert.equal(movedSidebar.x + movedSidebar.w + grid.gap, movedTerminal.x);
  assertTiling(grid, "after moving the shared line");
});

test("splitting keeps the original card and its near half", () => {
  const grid = three();
  const before = grid.card("terminal");
  const beforeRect = grid.rect("terminal");
  const id = grid.split("terminal", "x");

  assert.deepEqual(
    { id: grid.card("terminal").id, data: grid.card("terminal").data },
    { id: before.id, data: before.data },
    "the original card is still the one answering to the name",
  );
  assert.equal(grid.cards.length, 4);
  const after = grid.rect("terminal");
  assert.equal(after.x, beforeRect.x, "the original keeps the near edge");
  assert.ok(after.w < beforeRect.w);
  assert.ok(grid.rect(id).x > after.x, "the new card takes the far half");
  assertTiling(grid, "after split");
});

test("a card spanning the new line widens its span instead of being cut", () => {
  const grid = three();
  const before = grid.rect("browser");
  grid.split("terminal", "x");
  const after = grid.rect("browser");
  assert.deepEqual(
    { x: after.x, w: after.w },
    { x: before.x, w: before.w },
    "the card below is untouched",
  );
  assert.equal(grid.crossings(grid.card("browser")), 1, "it now spans one virtual line");
  assertTiling(grid, "with a straddling card");
});

test("a later split snaps to the line another card already made", () => {
  const grid = three();
  const first = grid.split("terminal", "x");
  const lines = grid.lines("x").length;
  grid.moveBoundary("x", 2, 0.75 * W);
  const moved = grid.boundaryPos("x", 2);

  const second = grid.split("browser", "x");
  assert.equal(grid.lines("x").length, lines, "no new line was drawn");
  assert.equal(grid.boundaryPos("x", 2), moved, "the line did not move");
  assert.equal(grid.rect(first).x, grid.rect(second).x, "both new cards share the edge");
  assertTiling(grid, "after snapping to an existing line");
});

test("splitting is refused when a half would fall under minSize", () => {
  const grid = make({ minSize: 96, gap: 24 });
  let splits = 0;
  while (grid.canSplit(grid.cards[0].id, "y") && splits < 100) {
    grid.split(grid.cards[0].id, "y");
    splits++;
  }
  assert.ok(splits > 0 && splits < 100);
  assert.equal(grid.split(grid.cards[0].id, "y"), null, "an extra split is a no-op");
  assertTiling(grid, "at the smallest card size");
});

test("canSplit is exactly 'two halves plus a corridor fit'", () => {
  const grid = three();
  for (const axis of ["x", "y"]) {
    for (const card of grid.cards) {
      const rect = grid.rectOf(card);
      const edge = axis === "x" ? rect.w : rect.h;
      const fits = !card.fixed && edge >= 2 * grid.minSize + grid.gap - 0.01;
      assert.equal(grid.canSplit(card.id, axis), fits, `${card.id} ${axis}`);
    }
  }
});

test("a fixed card is never split and never closed", () => {
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
  grid.moveBoundary("x", 2, 0.7 * W);
  const copy = Soksak.from(grid.toJSON(), { width: W, height: H });
  assert.deepEqual(copy.toJSON(), grid.toJSON());
  for (const card of grid.cards) {
    assert.deepEqual(copy.rect(card.id), grid.rect(card.id));
  }
});

test("a split carries the payload the host gives the new card", () => {
  const grid = three();
  const id = grid.split("terminal", "x", { id: "editor", data: { title: "editor", layer: 20 } });
  assert.equal(id, "editor");
  assert.deepEqual(grid.card("editor").data, { title: "editor", layer: 20 });
  // and the source keeps its own — a payload is never shared between two cards
  assert.equal(grid.card("terminal").data, undefined);
});

test("a split without a payload leaves data undefined rather than copying", () => {
  const grid = new Soksak(
    { xs: [0, 1], ys: [0, 1], cards: [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, data: { live: "surface-1" } }] },
    { width: W, height: H },
  );
  const id = grid.split("a", "x");
  assert.deepEqual(grid.card("a").data, { live: "surface-1" });
  assert.equal(grid.card(id).data, undefined, "copying would hand two cards one surface");
});
