import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "soksak";
import { arrangeWindowSidebars, windowSidebarsArranged, windowSidebarCards } from "../window-sidebars.js";

const ORDER = ["left", "right", "top", "bottom"];
const spans = (grid) => JSON.stringify(grid.cards.map(({ id, c0, c1, r0, r1, fixed }) => ({ id, c0, c1, r0, r1, fixed }))
  .sort((a, b) => (a.id < b.id ? -1 : 1)));

// The fixed sidebar of a side keeps its place and its size while the focus moves between plugins whose overrides choose its content
// (docs/spec/external-sidebars.md).
for (const side of ORDER) test(`window ${side} sidebar retains its side and size across plugin overrides`, () => {
  const units = [{ id: "alpha" }, { id: "beta" }];
  const links = [{ place: side, plugin: null, set: "general" }, ...units.map((unit) => ({ place: `window-${side}`, plugin: unit.id, set: unit.id }))];
  const grid = new Soksak({ xs: [0, 1], ys: [0, 1], cards: [{ id: "content", c0: 0, c1: 1, r0: 0, r1: 1 }] }, { width: 1000, height: 800 });
  const records = {};
  const arrange = (focus) => arrangeWindowSidebars(grid, ORDER, windowSidebarCards(units, links, focus).map((item) => item.id), records, 190,
    (shown) => shown === side);
  assert.equal(arrange("alpha"), true);
  assert.deepEqual(grid.cards.filter((card) => card.id !== "content").map((card) => card.id), [side]);
  const key = side === "left" || side === "right" ? "width" : "height";
  assert.deepEqual(records[side], { [key]: 190 });
  assert.equal(grid.setSize(side, side === "left" || side === "right" ? "x" : "y", 230), true);
  const before = spans(grid);
  assert.equal(arrange("beta"), false, "an override must not move the fixed sidebar");
  assert.equal(grid.card(side)[key], 230, "an override changed the size of the fixed sidebar");
  assert.deepEqual(records[side], { [key]: 230 }, "the record does not keep the size of the fixed sidebar");
  assert.equal(arrange(null), false, "the general choice must not move the fixed sidebar");
  assert.equal(grid.card(side)[key], 230, "the general choice changed the size of the fixed sidebar");
  assert.equal(spans(grid), before);
});

// A sidebar whose saved size leaves the content cards no room docks at the largest size that the plane holds
// (docs/spec/external-sidebars.md#fixed-placement-and-persistence): the layout refuses an insertion that takes a card below its
// minimum, and a missing sidebar or a refused arrangement is not that contract.
test("a window sidebar whose saved size leaves no room docks at the largest size that fits", () => {
  const grid = new Soksak({
    xs: [0, 0.5, 1],
    ys: [0, 0.25, 0.5, 0.75, 1],
    cards: [
      { id: "main", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "second", c0: 0, c1: 1, r0: 2, r1: 3 },
      { id: "third", c0: 0, c1: 2, r0: 1, r1: 2 },
      { id: "fourth", c0: 1, c1: 2, r0: 2, r1: 3 },
      { id: "fifth", c0: 1, c1: 2, r0: 0, r1: 1 },
    ],
  }, { width: 1000, height: 800 });
  const records = {};
  assert.equal(arrangeWindowSidebars(grid, ORDER, ORDER, records, 190, () => true), true);
  const top = grid.card("top");
  assert.ok(top, "the top sidebar is missing while its switch is on");
  assert.ok(0 < top.height && top.height < 190, `the top sidebar is not docked at a reduced size: ${top.height}`);
  for (const id of ["main", "second", "third", "fourth", "fifth"]) {
    const rect = grid.rect(id);
    assert.ok(rect.h >= grid.minSize - 0.5, `${id} is drawn at ${rect.h} below the minimum`);
    assert.ok(rect.w >= grid.minSize - 0.5, `${id} is drawn at ${rect.w} below the minimum`);
  }
  assert.ok(windowSidebarsArranged(grid, ORDER), "the reduced sidebar does not stand at its place");
  // A settle that changes nothing moves nothing and the record follows the size that the plane holds.
  assert.equal(arrangeWindowSidebars(grid, ORDER, ORDER, records, 190, () => true), false, "a quiet settle docked again");
  assert.equal(records.top.height, grid.card("top").height, "the record does not hold the size that the plane holds");
  // The plane that holds no size for a sidebar names the side it cannot place, and a quiet settle does not attempt the refused
  // arrangement again.
  const rows = ["main", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
  const tight = new Soksak({
    xs: [0, 1],
    ys: [0, 0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 0.88, 1],
    cards: rows.map((id, index) => ({ id, c0: 0, c1: 1, r0: index, r1: index + 1 })),
  }, { width: 1000, height: 800 });
  assert.throws(() => arrangeWindowSidebars(tight, ORDER, ["top"], {}, 190, () => true), /^Error: cannot place window sidebars top$/);
  assert.equal(tight.card("top"), undefined, "the dock left a sidebar where no size holds");
  assert.equal(arrangeWindowSidebars(tight, ORDER, ["top"], {}, 190, () => true), false, "a quiet settle attempted the refused arrangement");
});
