// The parts of the plan of an arrangement that hold no size rule (docs/spec/cli.md#planning-an-arrangement): the request tree, the
// grid of a count, the reading order and the resolution of the entries against the tabs of the plane.
import assert from "node:assert/strict";
import test from "node:test";
import { gridTree, readTree, readingOrder, resolveCards, treeCards } from "../layout-plan.js";

const TERMINAL = { plugin: "terminal", params: null };

test("a request tree is read with its defaults, and a tree outside the form is refused with its path", { timeout: 5000 }, () => {
  assert.deepEqual(readTree({ direction: "row", children: [{ tabs: [{ tab: "t1" }] }, { tabs: [{ plugin: "terminal" }], active: 0 }] }), {
    direction: "row", children: [{ tabs: [{ tab: "t1" }], active: 0 }, { tabs: [TERMINAL], active: 0 }],
  });
  for (const [tree, reason] of [
    [{ direction: "row", children: [{ tabs: [{ tab: "t1" }] }] }, "tree.children must hold at least two nodes"],
    [{ direction: "row", children: [{ tabs: [{ tab: "t1" }] }, { direction: "row", children: [{ tabs: [{ tab: "t2" }] }, { tabs: [{ tab: "t3" }] }] }] },
      "tree.children[1] is a row inside a row"],
    [{ tabs: [] }, "tree.tabs must be a non-empty list"],
    [{ tabs: [{ tab: "t1" }], active: 1 }, "tree.active must be an index of tabs"],
    [{ tabs: [{ plugin: "terminal", zone: "x" }] }, "tree.tabs[0] has the unknown member zone"],
    [{ direction: "diagonal", children: [] }, "tree.direction must be row or column"],
  ]) {
    assert.throws(() => readTree(tree), { message: reason });
  }
});

test("the grid of a count holds the larger rows first, and one row is a row of cards", { timeout: 5000 }, () => {
  const sizes = (tree) => (tree.direction === "column" ? tree.children.map((row) => treeCards(row).length) : [treeCards(tree).length]);
  assert.deepEqual(sizes(gridTree(10, 2, TERMINAL)), [5, 5]);
  assert.deepEqual(sizes(gridTree(7, 3, TERMINAL)), [3, 2, 2]);
  assert.deepEqual(sizes(gridTree(5, 1, TERMINAL)), [5]);
  assert.deepEqual(gridTree(1, 1, TERMINAL), { tabs: [TERMINAL], active: 0 });
});

test("the reading order of a tree is by the top and then the left edge of its equal shares", { timeout: 5000 }, () => {
  const card = { tabs: [TERMINAL], active: 0 };
  const column = (n) => ({ direction: "column", children: Array.from({ length: n }, () => card) });
  // A row of a column of two and a column of three: the top cards of both columns, the second of three, the second of two, the third.
  assert.deepEqual(readingOrder({ direction: "row", children: [column(2), column(3)] }), [0, 2, 3, 1, 4]);
  // Cards at one height in columns of two and four are one row, read from the left.
  assert.deepEqual(readingOrder({ direction: "row", children: [column(2), column(4)] }), [0, 2, 3, 1, 4, 5]);
});

test("the entries take the tabs of the plane in reading order, and a tab is kept or closed but never closed to move", { timeout: 5000 }, () => {
  const plane = [
    { tab: "t1", card: "c1", plugin: "terminal", params: null },
    { tab: "b1", card: "c1", plugin: "browser", params: { url: "a" } },
    { tab: "t2", card: "c2", plugin: "terminal", params: null },
  ];
  const cards = [{ tabs: [TERMINAL], active: 0 }, { tabs: [TERMINAL], active: 0 }, { tabs: [TERMINAL], active: 0 }];
  const kept = resolveCards(cards, plane);
  assert.deepEqual(kept.cards.map(({ card, tabs }) => [card, tabs.map(({ tab }) => tab)]), [["c1", ["t1", "b1"]], ["c2", ["t2"]], [null, [null]]]);
  assert.deepEqual([kept.kept, kept.closed], [["b1"], []]);
  const closed = resolveCards(cards, plane, { close: true });
  assert.deepEqual([closed.cards[0].tabs.map(({ tab }) => tab), closed.kept, closed.closed], [["t1"], [], ["b1"]]);
  // An entry {tab} is taken before the entries {plugin, params}, so the terminal of the second card moves into the first.
  const named = resolveCards([{ tabs: [{ tab: "t2" }], active: 0 }, { tabs: [TERMINAL], active: 0 }], plane);
  assert.deepEqual(named.cards.map(({ card, tabs }) => [card, tabs.map(({ tab }) => tab)]), [["c2", ["t2", "b1"]], ["c1", ["t1"]]]);
  assert.throws(() => resolveCards([{ tabs: [{ tab: "x9" }], active: 0 }], plane), { message: "tab x9 is not a tab of the active space" });
  assert.throws(() => resolveCards([{ tabs: [{ tab: "t1" }, { tab: "t1" }], active: 0 }], plane), { message: "tab t1 stands twice in the tree" });
});
