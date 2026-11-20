// The drawn arrangement of the group tree (docs/spec/groups.md#drawing): the rectangles of a fullscreen group card laid out as the whole
// area, and the rules and dividers of the grid cut at the headers and the frames of the group cards.
import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "soksak";
import { readGroupTree } from "../group-tree.js";

const GAP = 12, HEAD = 30, MIN = 40, W = 1200, H = 800;

/** A box of the group card id with its name and leader around the cut of the kids, each [share, node]. */
const box = (id, name, leader, cut, kids) => ({ box: id, data: { name, leader }, inner: split(cut, kids) });
/** A cut of the kids, each [share, node]; a string node is a card. */
const split = (cut, kids) => ({ cut, kids: kids.map(([share, node]) => ({ share, node: typeof node === "string" ? { card: node } : node })) });

/** card-6 holds the nested group card-5 of card-1 above card-3, and card-2 beside it; card-4 stands outside on the right. */
function nested() {
  const grid = new Soksak(undefined, { gap: GAP, minSize: MIN, width: W, height: H });
  const layout = {
    state: { root: split("x", [
      [2 / 3, box("card-6", "그룹 1", "card-5", "x", [[0.5, box("card-5", "그룹 2", "card-1", "y", [[0.5, "card-1"], [0.5, "card-3"]])], [0.5, "card-2"]])],
      [1 / 3, "card-4"],
    ]) },
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

/**
 * The tree at the seam, whose gap is the border width LINE: card-7 holds card-6 and card-2, card-6 holds card-5 above card-4, and card-5
 * holds card-1 and card-3 side by side; card-8 stands outside every group at the right. So the left edge of the plane ends three group
 * cards beside card-1, the line between card-3 and card-2 ends two, and the headers of card-7, card-6 and card-5 stack at the top.
 */
const LINE = 1;
function seam() {
  const grid = new Soksak(undefined, { gap: LINE, minSize: MIN, width: W, height: H });
  const layout = {
    state: { root: split("x", [
      [0.75, box("card-7", "그룹 3", "card-6", "x", [
        [2 / 3, box("card-6", "그룹 2", "card-5", "y", [[0.5, box("card-5", "그룹 1", "card-1", "x", [[0.5, "card-1"], [0.5, "card-3"]])], [0.5, "card-4"]])],
        [1 / 3, "card-2"],
      ])],
      [0.25, "card-8"],
    ]) },
    leader: "card-7", lastCard: 8,
  };
  return readGroupTree(layout, { gap: LINE, minSize: MIN, head: HEAD, seam: true }, grid);
}

test("at the seam every line between two boxes and under a header is one line of the border width, however many group cards end on it", () => {
  const tree = seam();
  const r = (id) => tree.rect(id);
  const right = (id) => r(id).x + r(id).w;
  const bottom = (id) => r(id).y + r(id).h;
  const head = (id) => tree.headRect(id);
  const apart = (a, b, where) => near(b - a, LINE, `${where}: the distance between the boxes`);
  apart(right("card-3"), r("card-2").x, "between card-3 and card-2, where card-5 and card-6 end");
  apart(right("card-4"), r("card-2").x, "between card-4 and card-2, where card-6 ends");
  apart(right("card-2"), r("card-8").x, "between card-2 and card-8, where card-7 ends");
  apart(bottom("card-1"), r("card-4").y, "between card-1 and card-4, where card-5 ends");
  apart(right("card-1"), r("card-3").x, "between card-1 and card-3 inside card-5");
  for (const id of ["card-5", "card-6", "card-7"]) near(r(id).x, r("card-1").x, `the left side of the frame of ${id} and of card-1`);
  near(r("card-7").x, 0, "the left side of card-7 at the edge of the plane");
  near(right("card-5"), right("card-3"), "the right side of the frame of card-5 and of card-3");
  near(right("card-6"), right("card-4"), "the right side of the frame of card-6 and of card-4");
  near(right("card-7"), right("card-2"), "the right side of the frame of card-7 and of card-2");
  for (const id of ["card-6", "card-7"]) near(bottom(id), bottom("card-4"), `the bottom of the frame of ${id} and of card-4`);
  near(bottom("card-7"), H, "the bottom of card-7 at the edge of the plane");
  near(head("card-6").y, head("card-7").y + head("card-7").h, "the header of card-6 under the header of card-7");
  near(head("card-5").y, head("card-6").y + head("card-6").h, "the header of card-5 under the header of card-6");
  near(r("card-1").y, head("card-5").y + head("card-5").h, "card-1 under the header of card-5");
  near(r("card-2").y, head("card-7").y + head("card-7").h, "card-2 under the header of card-7");
  const shown = tree.fullscreen("card-7", { x: 0, y: 0, w: W, h: H });
  near(shown.get("card-1").x, 0, "card-1 at the left of card-7 shown fullscreen");
  near(shown.get("card-1").y, 3 * HEAD, "card-1 under the three headers of card-7 shown fullscreen");
});

/** The length of the grip of a divider along its line, the chrome metric sp-grip-length. */
const GRIP = 24;

// A divider draws its grip at the center of each drawn stretch that holds the grip and none on a shorter stretch, so no grip reaches into
// a header: card-6 holds card-5 of card-1 beside card-3 at its top, so the line between card-1 and card-3 crosses the headers of card-6
// and card-5 and keeps a stretch of one gap between them (docs/spec/groups.md#drawing).
test("a divider draws its grip only on a drawn stretch that holds the grip", () => {
  const grid = new Soksak(undefined, { gap: GAP, minSize: MIN, width: W, height: H });
  const tree = readGroupTree({
    state: { root: box("card-6", "그룹 1", "card-5", "x", [[0.5, box("card-5", "그룹 2", "card-1", "x", [[0.5, "card-1"], [0.5, "card-3"]])], [0.5, "card-2"]]) },
    leader: "card-6", lastCard: 6,
  }, { gap: GAP, minSize: MIN, head: HEAD }, grid);
  const dividers = tree.drawnDividers(grid.dividers(), GRIP);
  const length = (divider) => (divider.axis === "x" ? divider.h : divider.w);
  for (const divider of dividers) {
    assert.equal(divider.grip, length(divider) >= GRIP, `the divider ${divider.key} of length ${length(divider)} draws grip ${divider.grip}`);
  }
  const line = dividers.filter((divider) => divider.axis === "x" && divider.line === 1);
  assert.ok(line.some((divider) => !divider.grip && length(divider) > 0), "the line between card-1 and card-3 has no stretch between the headers");
  assert.equal(line.filter((divider) => divider.grip).length, 1, "the line between card-1 and card-3 draws one grip beside the cards");
});
