// The drawn arrangement of the group tree (docs/spec/groups.md#drawing): the rectangles of a fullscreen group card laid out as the whole
// area, and the rules and dividers of the grid cut at the headers and the frames of the group cards.
import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "soksak";
import { readGroupTree } from "../group-tree.js";

const GAP = 12, HEAD = 30, MIN = 40, W = 1200, H = 800;

/** card-6 holds the nested group card-5 of card-1 above card-3, and card-2 beside it; card-4 stands outside on the right. */
function nested() {
  const grid = new Soksak(undefined, { gap: GAP, minSize: MIN, width: W, height: H });
  const layout = {
    state: { xs: [0, 1 / 3, 2 / 3, 1], ys: [0, 0.5, 1], cards: [
      { id: "card-1", c0: 0, c1: 1, r0: 0, r1: 1 }, { id: "card-3", c0: 0, c1: 1, r0: 1, r1: 2 },
      { id: "card-2", c0: 1, c1: 2, r0: 0, r1: 2 }, { id: "card-4", c0: 2, c1: 3, r0: 0, r1: 2 }] },
    groups: [{ card: "card-6", name: "그룹 1", leader: "card-5", members: [
      { card: "card-5", name: "그룹 2", leader: "card-1", members: ["card-1", "card-3"] }, "card-2"] }],
    leader: "card-6", lastCard: 6,
  };
  return readGroupTree(layout, { gap: GAP, minSize: MIN, head: HEAD }, grid);
}

const near = (a, b, where) => assert.ok(Math.abs(a - b) < 1e-6, `${where}: ${a} is not ${b}`);
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;

test("a fullscreen group card is laid out as the whole area with every frame and header one gap inside it", () => {
  const tree = nested();
  const area = { x: 0, y: 0, w: W, h: H };
  const shown = tree.fullscreen("card-6", area);
  assert.deepEqual([...shown.keys()].sort(), ["card-1", "card-2", "card-3", "card-5", "card-6"], "the cards outside card-6 are not shown");
  assert.deepEqual(shown.get("card-6"), area);
  const step = HEAD + GAP;
  const inner = shown.get("card-5"), first = shown.get("card-1"), beside = shown.get("card-2"), below = shown.get("card-3");
  near(inner.x, GAP, "card-5 stands one gap inside the left of the area");
  near(inner.y, step, "card-5 stands below the header of card-6");
  near(first.x, 2 * GAP, "card-1 stands one gap inside card-5");
  near(first.y, 2 * step, "card-1 stands below the headers of card-6 and card-5");
  near(beside.x + beside.w, W - GAP, "card-2 stands one gap inside the right of the area");
  near(beside.y, step, "card-2 stands below the header of card-6");
  near(below.y + below.h, H - 2 * GAP, "card-3 stands one gap inside card-5 and card-6 at the bottom");
  assert.equal(tree.fullscreen("card-1", area), null, "a content card is no group card to lay out");
});

test("no divider crosses a group header, and a rule inside a group card stays inside its frame below its header", () => {
  const tree = nested();
  const grid = tree.grid;
  const heads = ["card-6", "card-5"].map((id) => tree.headRect(id));
  const dividers = tree.drawnDividers(grid.dividers());
  assert.ok(dividers.length >= grid.dividers().length, "every divider is drawn in one part or more");
  for (const divider of dividers) for (const head of heads) assert.ok(!overlap(divider, head), `the divider ${divider.key} crosses a header`);
  const rules = tree.drawnRules(grid.rules());
  const outer = tree.rect("card-6"), outerHead = tree.headRect("card-6");
  // The x rule of line 1 lies between card-5 and card-2 inside card-6.
  const inside = rules.filter((rule) => rule.axis === "x" && rule.line === 1);
  assert.ok(inside.length > 0, "the rule of line 1 is drawn");
  for (const rule of inside) {
    assert.equal(rule.bleed, false, `the rule ${rule.key} inside a group card does not reach into the stage padding`);
    assert.ok(rule.y >= outerHead.y + outerHead.h - 1e-6 && rule.y + rule.h <= outer.y + outer.h + 1e-6,
      `the rule ${rule.key} at ${rule.y}..${rule.y + rule.h} leaves the frame of card-6 below its header`);
  }
  // The x rule of line 2 between card-6 and card-4 lies outside every group card.
  const outside = rules.filter((rule) => rule.axis === "x" && rule.line === 2);
  assert.ok(outside.length > 0 && outside.every((rule) => rule.bleed), "a rule outside every group card keeps the bleed");
  for (const rule of rules) for (const head of heads) assert.ok(!overlap(rule, head), `the rule ${rule.key} crosses a header`);
});
