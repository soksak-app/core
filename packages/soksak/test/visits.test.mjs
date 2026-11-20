import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";

/**
 * Every operation of the grid is linear in the nodes that it touches
 * (packages/soksak/docs/layout.md#cuts): the grid keeps a map from each id to
 * its node and from each coordinate to its line, so no operation scans the
 * whole tree for one card. `visits` counts the nodes of the tree that the last
 * operation visited, and the bound below is a fixed number of visits per node,
 * which an operation that scans the tree for each of its cards exceeds by the
 * number of cards.
 */

/** The visits per node that an operation may make: each derive, commit and pass of a cut operation visits every node once. */
const PER_NODE = 64;

/** A grid of 500 cards: 20 rows of 25 columns, each column a cut of its rows. */
function large() {
  const grid = new Soksak({ root: { card: "card-1" } }, { width: 25 * 140, height: 20 * 140, gap: 10, minSize: 40 });
  const cards = [];
  for (let i = 1; i <= 500; i++) cards.push({ card: `card-${i}` });
  const columns = [];
  for (let c = 0; c < 25; c++) {
    const kids = [];
    for (let r = 0; r < 20; r++) kids.push({ share: 1 / 20, node: cards[r * 25 + c] });
    columns.push({ share: 1 / 25, node: { cut: "y", kids } });
  }
  grid.replace({ root: { cut: "x", kids: columns } });
  return grid;
}

/** The number of nodes of the tree of a grid. */
function nodes(grid) {
  const count = (node) => 1 + (node.cut ? node.kids.reduce((a, kid) => a + count(kid.node), 0) : node.box ? count(node.inner) : 0);
  return count(grid.toJSON().root);
}

const operations = [
  ["split", (g) => g.split("card-260", "x")],
  ["splitToward", (g) => g.splitToward("card-260", "top")],
  ["close", (g) => g.close("card-260")],
  ["move", (g) => g.move("card-260", "card-13", "right")],
  ["moveBoundary", (g) => g.moveBoundary("x", 12, g.boundaryPos("x", 12) + 20)],
  ["centerBoundary", (g) => {
    g.moveBoundary("y", 10, g.boundaryPos("y", 10) + 30);
    return g.centerBoundary("y", 10);
  }],
  ["insertAt", (g) => g.insertAt("x", 0, { id: "side", size: 200 })],
  ["insert", (g) => g.insert("card-260", "right", { card: "new" })],
  ["withdraw", (g) => g.withdraw("card-260")],
  ["even", (g) => g.even()],
  ["arrange", (g) => g.arrange("even")],
];

for (const [name, run] of operations) {
  test(`${name} on 500 cards visits a bounded number of nodes per node of the tree`, { timeout: 60000 }, () => {
    const grid = large();
    const count = nodes(grid);
    const result = run(grid);
    assert.ok(result !== null && result !== false, `${name} is refused`);
    assert.ok(grid.visits > 0, `${name} counts no visit`);
    assert.ok(grid.visits <= PER_NODE * count, `${name} visited ${grid.visits} nodes of a tree of ${count}, more than ${PER_NODE} per node`);
    console.log(`${name}: ${grid.visits} visits of a tree of ${count} nodes`);
  });
}
