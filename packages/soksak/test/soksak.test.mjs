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
  const upper = grid.rect("upper");
  assert.equal(sidebar.x + sidebar.w + grid.gap, upper.x);
  grid.moveBoundary("x", 1, 0.5 * W);
  const movedSidebar = grid.rect("sidebar");
  const movedTerminal = grid.rect("upper");
  assert.equal(movedSidebar.x + movedSidebar.w + grid.gap, movedTerminal.x);
  assertTiling(grid, "after moving the shared line");
});

test("splitting keeps the original card and its near half", () => {
  const grid = three();
  const before = grid.card("upper");
  const beforeRect = grid.rect("upper");
  const id = grid.split("upper", "x");

  assert.deepEqual(
    { id: grid.card("upper").id, data: grid.card("upper").data },
    { id: before.id, data: before.data },
    "the original card is still the one answering to the name",
  );
  assert.equal(grid.cards.length, 4);
  const after = grid.rect("upper");
  assert.equal(after.x, beforeRect.x, "the original keeps the near edge");
  assert.ok(after.w < beforeRect.w);
  assert.ok(grid.rect(id).x > after.x, "the new card takes the far half");
  assertTiling(grid, "after split");
});

test("a card spanning the new line widens its span instead of being cut", () => {
  const grid = three();
  const before = grid.rect("lower");
  grid.split("upper", "x");
  const after = grid.rect("lower");
  assert.deepEqual(
    { x: after.x, w: after.w },
    { x: before.x, w: before.w },
    "the card below is untouched",
  );
  assert.equal(grid.crossings(grid.card("lower")), 1, "it now spans one virtual line");
  // The count is over both axes: the sidebar spans across the line between
  // upper and lower, and reading only one axis reports it as none.
  assert.equal(
    grid.crossings(grid.card("sidebar")),
    1,
    "and the sidebar spans one on the other axis",
  );
  assertTiling(grid, "with a straddling card");
});

test("a later split snaps to the line another card already made", () => {
  const grid = three();
  const first = grid.split("upper", "x");
  const lines = grid.lines("x").length;
  grid.moveBoundary("x", 2, 0.75 * W);
  const moved = grid.boundaryPos("x", 2);

  const second = grid.split("lower", "x");
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
  assert.throws(() => grid.split(grid.cards[0].id, "y"), { message: "card card would be 1600x87, below its minimum 96x96" }, "an extra split is refused");
  assertTiling(grid, "at the smallest card size");
});

test("splitting is refused when it would take another card below the size it has", () => {
  // The cut adds a line and the line takes a gap, and that gap comes out of the
  // sharing slots — so a cut narrows cards it does not touch. `card-1` declares
  // more than the plane holds, so `card` is drawn at exactly `minSize`, and the
  // cut would take it under. `minSize` binds the operation: what the halves of
  // the cut can hold is not the only question.
  const grid = Soksak.from(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "card" } }, { share: 0.5, node: { card: "card-1", width: 271 } }] } },
    { width: 158, height: 158, gap: 18, minSize: 58 },
  );
  const before = grid.rect("card").w;
  assert.equal(before, grid.minSize, "the plane draws it at exactly the floor");

  assert.equal(grid.canSplit("card-1", "x"), false, "so no cut may make it narrower");
  assert.throws(() => grid.split("card-1", "x"), { message: "card card-1 would be 32x158, below its minimum 58x58" }, "and the cut is refused");
  assert.equal(grid.rect("card").w, before, "and nothing moved");
  assert.equal(grid.cards.length, 2, "no card was added");
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
  assert.throws(() => grid.split("sidebar", "x"), { message: "card sidebar is fixed and does not split" });
  assert.equal(grid.close("sidebar"), false);
});

test("state round-trips through JSON", () => {
  const grid = three();
  grid.split("upper", "x", { id: "writer", data: { pty: 7 } });
  grid.setSize("sidebar", "x", 210);
  grid.setFixed("sidebar", true);
  grid.moveBoundary("x", 2, 0.7 * W);
  const copy = Soksak.from(grid.toJSON(), { width: W, height: H });

  // Comparing the two toJSON results would pass on a state that drops a
  // field, since both sides forget it. Read the copy through the API instead,
  // and against values named here rather than fetched from the original.
  assert.deepEqual(copy.card("writer").data, { pty: 7 }, "the payload came across");
  assert.equal(copy.card("sidebar").width, 210, "and the px size");
  assert.equal(copy.card("sidebar").fixed, true, "and the role");
  assert.deepEqual(copy.cards.map((c) => c.id).sort(), grid.cards.map((c) => c.id).sort());
  for (const card of grid.cards) assert.deepEqual(copy.rect(card.id), grid.rect(card.id));

  // Behaviour, not just shape: the same operation must do the same thing.
  const same = Soksak.from(grid.toJSON(), { width: W, height: H });
  assert.equal(same.close("writer"), grid.close("writer"));
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
  const id = grid.split("upper", "x", { id: "writer", data: { title: "writer", layer: 20 } });
  assert.equal(id, "writer");
  assert.deepEqual(grid.card("writer").data, { title: "writer", layer: 20 });
  // and the source keeps its own — a payload is never shared between two cards
  assert.equal(grid.card("upper").data, undefined);
});

test("a split without a payload leaves data undefined rather than copying", () => {
  const grid = new Soksak(
    { root: { card: "a", data: { live: "surface-1" } } },
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
  assert.throws(() => grid.split("card", "y", { id: "dup" }), { message: "card dup is a member of the layout" });
  assert.throws(() => grid.splitToward("card", "left", { id: "dup" }), { message: "card dup is a member of the layout" });
  assert.equal(grid.insertAt("x", 0, { id: "dup", size: 100 }), null);
  assert.equal(grid.cards.length, grid.rects().size);
  assert.equal(new Set(grid.cards.map((c) => c.id)).size, grid.cards.length);
});

test("an axis the caller made up is refused, and a split throws it", () => {
  const grid = new Soksak(undefined, { width: 1200, height: 800 });
  // A plane with one card has no boundary on either axis, so every reader below
  // refuses "x" as well and the axis decides nothing. Cut on both axes first.
  grid.split("card", "x");
  grid.split("card", "y");
  assert.equal(grid.hasBoundary("x", 1), true, "there is a boundary to answer for");
  assert.equal(grid.hasBoundary("y", 1), true);
  const z = "z";
  const results = {
    lines: () => grid.lines(z),
    cardsCrossing: () => grid.cardsCrossing(z, 1),
    boundaryPos: () => grid.boundaryPos(z, 1),
    boundaryRange: () => grid.boundaryRange(z, 1),
    hasBoundary: () => grid.hasBoundary(z, 1),
    moveBoundary: () => grid.moveBoundary(z, 1, 10),
    centerBoundary: () => grid.centerBoundary(z, 1),
    canSplit: () => grid.canSplit("card", z),
    setSize: () => grid.setSize("card", z, 10),
    canInsertAt: () => grid.canInsertAt(z, 1),
    insertAt: () => grid.insertAt(z, 1, { size: 10 }),
    moveTo: () => grid.moveTo("card", z, 1),
    standings: () => grid.standings(z),
  };
  // A refusal is null, false, zero, or an answer with nothing in it. Checking
  // only that nothing threw leaves every reader free to answer as if "x" had
  // been passed.
  const refused = (v) =>
    v === null || v === false || v === 0 ||
    (Array.isArray(v) && (v.length === 0 || v.every((n) => n === 0)));

  const before = JSON.stringify(grid.toJSON());
  for (const [name, ask] of Object.entries(results)) {
    let answer;
    assert.doesNotThrow(() => { answer = ask(); }, `${name} threw`);
    assert.ok(refused(answer), `${name} answered ${JSON.stringify(answer)}`);
  }
  // A split throws its refusal, and an axis it does not know is one.
  assert.throws(() => grid.split("card", z), { message: "unknown axis z; use x or y" });
  assert.equal(JSON.stringify(grid.toJSON()), before, "and none of them changed anything");
});

test("a state that cannot describe a plane is refused, and names the fault", () => {
  // A layout read back from storage otherwise reaches the geometry, where a bad
  // index becomes a NaN rect and the view freezes with nothing to report.
  const cases = [
    [{ xs: [0, 1], ys: [0, 1], cards: [] }, /which is the earlier form/],
    [{ root: { foo: 1 } }, /is not a card, a box or a cut/],
    [{ root: { cut: "x", kids: [{ share: 1, node: { card: "a" } }] } }, /has fewer than two kids/],
    [
      { root: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.4, node: { card: "b" } }] } },
      /shares sum to 0\.9/,
    ],
    [
      { root: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "a" } }] } },
      /card a is stored twice/,
    ],
  ];
  for (const [state, why] of cases) {
    assert.throws(() => new Soksak(state, { width: 800, height: 600 }), why, JSON.stringify(state));
  }

  const good = { root: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "b" } }] } };
  assert.doesNotThrow(() => new Soksak(good, { width: 800, height: 600 }));
});

test("a side the caller made up is refused", () => {
  const grid = new Soksak(undefined, { width: 1600, height: 1000 });
  // axisOf returns "y" for anything but left and right, so a misspelled side
  // would split downward without saying so.
  const other = grid.split("card", "x", { id: "other" });
  assert.ok(other, "two cards to move between");
  assert.throws(() => grid.splitToward("card", "sideways", { id: "q" }), { message: "unknown side sideways; use left, right, top or bottom" });
  // Two different cards: moving a card onto itself is refused for its own
  // reason, so it does not name the side.
  assert.equal(grid.move("card", other, "sideways"), false, "a side that is not one");
  assert.equal(grid.canMove("card", other, "sideways"), false);
  const before = JSON.stringify(grid.toJSON());
  assert.equal(grid.move("card", other, "sideways"), false);
  assert.equal(JSON.stringify(grid.toJSON()), before, "and nothing changed");
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
  grid.gap = 600;                       // two corridors take the whole width
  const [id, r] = [...grid.rects()].find(([, box]) => box.w === 0) ?? [];
  assert.ok(id, "one card has no width");
  // Dividing by a zero width gives NaN, and every comparison then falls to the
  // last branch, so every point on the card read as one side.
  assert.deepEqual(grid.zoneAt(r.x, r.y + r.h / 2), { id, zone: "centre" });
});

test("no change leaves a card with no area, whatever minSize allows", () => {
  // minSize is zero, so nothing below is too small — except nothing itself. The
  // gap here takes half of the height, and a second cut would leave the cards
  // drawn at no height at all.
  const grid = new Soksak(undefined, { width: 1200, height: 800, gap: 400, minSize: 0 });
  grid.split("card", "y");
  assert.equal(grid.rect("card").h, 200, "two cards, each with room");

  assert.equal(grid.canSplit("card", "y"), false, "a third would have no height");
  assert.throws(() => grid.split("card", "y"), { message: "card card would be 1200x0 and have no area" });
  assert.equal(grid.cards.length, 2, "and the refusal left the plane alone");
  for (const [id, r] of grid.rects()) {
    assert.ok(r.w > 0 && r.h > 0, `${id} is drawn at ${r.w}x${r.h}`);
  }
});

test("an insert that would leave a card with no area is refused where minSize is 0", () => {
  // With minSize 0 the minimum does not refuse a card drawn at no size, so the area check alone refuses this insert.
  const grid = new Soksak(undefined, { width: 386, height: 130, gap: 12, minSize: 0 });
  const steps = [["split", "card", "x", { id: "n0" }], ["insertAt", "x", 2, { id: "i1", size: 6 }], ["close", "n0"], ["close", "i1"], ["split", "card", "y", { id: "n4" }], ["split", "card", "y", { id: "n5" }], ["split", "card", "x", { id: "n6" }], ["setSize", "n6", "x", 281], ["split", "card", "x", { id: "n8" }], ["split", "n4", "y", { id: "n9" }], ["split", "n4", "x", { id: "n10" }]];
  for (const [method, ...args] of steps) grid[method](...args);
  const before = JSON.stringify(grid.toJSON());
  assert.equal(grid.insertAt("x", 3, { id: "i11", size: 118 }), null);
  assert.equal(JSON.stringify(grid.toJSON()), before, "a refusal changes nothing");
  for (const [id, r] of grid.rects()) assert.ok(r.w > 0 && r.h > 0, `${id} has an area`);
});
