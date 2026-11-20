// The answers of the head buttons of a space with groups, canSplit, canGroup and canClose of packages/workbench/group-tree.js, hold
// until the layout changes: the plane asks them for every card head and group header in each draw, and a draw without a layout change
// runs no trial operation (probe).
import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "soksak";
import { readGroupTree } from "../group-tree.js";

const OPTIONS = { gap: 12, minSize: 96, head: 28 };

test("the head answers of a group tree hold until the layout changes", { timeout: 5000 }, () => {
  const grid = new Soksak(undefined, { gap: OPTIONS.gap, minSize: OPTIONS.minSize, width: 1600, height: 1200 });
  const tree = readGroupTree({ state: { root: { card: "card-1" } },
    leader: "card-1", lastCard: 1 }, OPTIONS, grid);
  tree.create("card-1", "right", undefined, false);
  const ask = () => {
    for (const { id } of tree.order()) {
      tree.canSplit(id, "right", false);
      tree.canSplit(id, "bottom", false);
      tree.canGroup(id, false);
      tree.canClose(id);
    }
  };
  ask();
  const first = tree.probes;
  assert.ok(first > 0, "the head answers ran no trial operation");
  ask();
  assert.equal(tree.probes - first, 0, "a second draw without a layout change ran trial operations");
  tree.split("card-1", "bottom", undefined, false);
  ask();
  assert.notEqual(tree.probes, first, "after a split the head answers were kept");
  const moved = tree.probes;
  grid.resize(1400, 1200);
  ask();
  assert.notEqual(tree.probes, moved, "after a resize of the plane the head answers were kept");
});
