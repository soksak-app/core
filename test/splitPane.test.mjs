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
  grid.split("terminal", "x", { id: "editor", data: { pty: 7 } });
  grid.setSize("sidebar", "x", 210);
  grid.setFixed("sidebar", true);
  grid.moveBoundary("x", 2, 0.7 * W);
  const copy = Soksak.from(grid.toJSON(), { width: W, height: H });

  // Comparing the two toJSON results would pass on a state that drops a
  // field, since both sides forget it. Read the copy through the API instead,
  // and against values named here rather than fetched from the original.
  assert.deepEqual(copy.card("editor").data, { pty: 7 }, "the payload came across");
  assert.equal(copy.card("sidebar").width, 210, "and the px size");
  assert.equal(copy.card("sidebar").fixed, true, "and the role");
  assert.deepEqual(copy.cards.map((c) => c.id).sort(), grid.cards.map((c) => c.id).sort());
  for (const card of grid.cards) assert.deepEqual(copy.rect(card.id), grid.rect(card.id));

  // Behaviour, not just shape: the same operation must do the same thing.
  const same = Soksak.from(grid.toJSON(), { width: W, height: H });
  assert.equal(same.close("editor"), grid.close("editor"));
  assert.deepEqual(
    [...same.rects()].map(([id, r]) => [id, r.w, r.h]),
    [...grid.rects()].map(([id, r]) => [id, r.w, r.h]),
    "and leaves the same plane",
  );
});

test("every field of a card survives the round trip", () => {
  // Named one by one: a comparison of two toJSON results cannot see a field
  // the state drops, because it is missing from both.
  const grid = new Soksak(undefined, { width: W, height: H });
  const b = grid.split("card", "x", { id: "b", data: { deep: { n: 1 } } });
  grid.setSize("card", "x", 180);
  grid.setFixed("card", true);
  grid.setData(b, { deep: { n: 2 } });

  const copy = Soksak.from(grid.toJSON(), { width: W, height: H });
  for (const field of ["id", "c0", "c1", "r0", "r1", "fixed", "width", "height", "data"]) {
    for (const card of grid.cards) {
      assert.deepEqual(copy.card(card.id)[field], card[field], `${card.id}.${field}`);
    }
  }
  assert.deepEqual(copy.lines("x"), grid.lines("x"));
  assert.deepEqual(copy.lines("y"), grid.lines("y"));
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

test("an id already in use is refused, so no two cards share a name", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 800 });
  assert.equal(grid.split("card", "x", { id: "dup" }), "dup");
  // rects() and the view key by id: a second card called `dup` would have no
  // rect and no element of its own.
  assert.equal(grid.split("card", "y", { id: "dup" }), null);
  assert.equal(grid.splitToward("card", "left", { id: "dup" }), null);
  assert.equal(grid.insertAt("x", 0, { id: "dup", size: 100 }), null);
  assert.equal(grid.cards.length, grid.rects().size);
  assert.equal(new Set(grid.cards.map((c) => c.id)).size, grid.cards.length);
});

test("an axis the caller made up is refused, not thrown on", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 800 });
  const z = "z";
  const results = {
    lines: () => grid.lines(z),
    cardsCrossing: () => grid.cardsCrossing(z, 1),
    isVirtual: () => grid.isVirtual(z, 1),
    boundaryPos: () => grid.boundaryPos(z, 1),
    boundaryRange: () => grid.boundaryRange(z, 1),
    hasBoundary: () => grid.hasBoundary(z, 1),
    moveBoundary: () => grid.moveBoundary(z, 1, 10),
    centerBoundary: () => grid.centerBoundary(z, 1),
    mergeCoincident: () => grid.mergeCoincident(z, 1),
    canSplit: () => grid.canSplit("card", z),
    split: () => grid.split("card", z),
    setSize: () => grid.setSize("card", z, 10),
    canInsertAt: () => grid.canInsertAt(z, 1),
    insertAt: () => grid.insertAt(z, 1, { size: 10 }),
    moveTo: () => grid.moveTo("card", z, 1),
    standings: () => grid.standings(z),
  };
  const before = JSON.stringify(grid.toJSON());
  for (const [name, ask] of Object.entries(results)) {
    assert.doesNotThrow(ask, `${name} threw`);
  }
  assert.equal(JSON.stringify(grid.toJSON()), before, "and none of them changed anything");
});

test("a state that cannot describe a plane is refused, and names the fault", () => {
  // A layout read back from storage otherwise reaches the geometry, where a bad
  // index becomes a NaN rect and the view freezes with nothing to report.
  const cases = [
    [{ xs: [], ys: [0, 1], cards: [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1 }] }, /xs needs at least two/],
    [{ xs: [0, 1], ys: [0, 1], cards: [{ id: "a", c0: 0, c1: 5, r0: 0, r1: 1 }] }, /outside xs/],
    [{ xs: [0, 1], ys: [0, 1], cards: [{ id: "a", c0: -1, c1: 1, r0: 0, r1: 1 }] }, /outside xs/],
    [{ xs: [0, 0.5, 1], ys: [0, 1], cards: [{ id: "a", c0: 2, c1: 1, r0: 0, r1: 1 }] }, /not past/],
    [{ xs: [0, NaN, 1], ys: [0, 1], cards: [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1 }] }, /xs\[1\] is NaN/],
    [{ xs: [0, 0.8, 0.3, 1], ys: [0, 1], cards: [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1 }] }, /before/],
    [{ xs: [0, 1], ys: [0, 1], cards: [] }, /cards is empty/],
    [
      { xs: [0, 0.5, 1], ys: [0, 1], cards: [
        { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
        { id: "a", c0: 1, c1: 2, r0: 0, r1: 1 },
      ] },
      /two cards are called a/,
    ],
  ];
  for (const [state, why] of cases) {
    assert.throws(() => new Soksak(state, { width: 800, height: 600 }), why, JSON.stringify(state));
  }

  const good = { xs: [0, 0.5, 1], ys: [0, 1], cards: [
    { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
    { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
  ] };
  assert.doesNotThrow(() => new Soksak(good, { width: 800, height: 600 }));
});

test("a side the caller made up is refused", () => {
  const grid = new Soksak(undefined, { width: 1600, height: 1000 });
  const before = JSON.stringify(grid.toJSON());
  // axisOf returns "y" for anything but left and right, so a misspelled side
  // would split downward without saying so.
  assert.equal(grid.splitToward("card", "sideways", { id: "q" }), null);
  assert.equal(grid.move("card", "card", "sideways"), false);
  assert.equal(JSON.stringify(grid.toJSON()), before);
  assert.equal(typeof grid.splitToward("card", "left", { id: "q" }), "string");
});

test("a line index that is not one returns a number, not undefined", () => {
  const grid = new Soksak(undefined, { width: 1600, height: 1000 });
  grid.split("card", "x");
  for (const line of [99, -1, 1.5, NaN]) {
    assert.equal(typeof grid.boundaryPos("x", line), "number", String(line));
  }
  assert.ok(grid.boundaryPos("x", 1) > 0, "and a real one still returns a number");
});

test("a card drawn with no area returns centre, not a side", () => {
  const grid = new Soksak(undefined, { width: 1000, height: 200, gap: 24, minSize: 0 });
  const b = grid.split("card", "x");
  grid.split(b, "x");
  grid.gap = 400;                       // more corridor than a slot can hold
  const [id, r] = [...grid.rects()].find(([, box]) => box.w === 0) ?? [];
  assert.ok(id, "one card has no width");
  // Dividing by a zero width gives NaN, and every comparison then falls to the
  // last branch, so every point on the card read as one side.
  assert.deepEqual(grid.zoneAt(r.x, r.y + r.h / 2), { id, zone: "centre" });
});
