// The shared layout cases of the groups of a space (docs/spec/groups.md), docs/spec/cases/layout/groups.json, against the group tree of
// the page workbench, packages/workbench/group-tree.js. The Go layout model of packages/workbench-mygo runs the same file, so a case is
// one statement of the groups that both workbenches meet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Soksak } from "soksak";
import { readGroupTree } from "../group-tree.js";

const file = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/layout/groups.json", import.meta.url), "utf8"));

/** The relative difference under which two numbers of a case are the same, as the Go runner compares them. */
const TOLERANCE = 1e-9;

/** The first difference between actual and expected, both in the form that JSON gives them, with numbers compared within TOLERANCE. */
function difference(actual, expected, where) {
  if (typeof expected === "number") {
    if (typeof actual !== "number") return `${where}: ${JSON.stringify(actual)} is not a number`;
    const bound = TOLERANCE * Math.max(1, Math.abs(actual), Math.abs(expected));
    return Math.abs(actual - expected) > bound ? `${where}: ${actual} is not ${expected}` : null;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${where}: ${JSON.stringify(actual)} is not a list`;
    if (actual.length !== expected.length) return `${where}: ${actual.length} items, not ${expected.length}`;
    for (let i = 0; i < expected.length; i++) {
      const found = difference(actual[i], expected[i], `${where}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return `${where}: ${JSON.stringify(actual)} is not an object`;
    const keys = (value) => Object.keys(value).sort().join(",");
    if (keys(actual) !== keys(expected)) return `${where}: the keys ${keys(actual)} are not ${keys(expected)}`;
    for (const key of Object.keys(expected)) {
      const found = difference(actual[key], expected[key], `${where}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return actual === expected ? null : `${where}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`;
}

/**
 * Runs one step on the tree and returns the value of the call. create, split, close, dissolve, rename, leader and move answer as the
 * commands core.group.create, core.card.split, core.card.close, core.group.dissolve, core.group.rename, core.group.leader and core.card.move
 * without tabs, add as the add of a card to a group card, and boundary as core.boundary.move.
 */
function call(tree, grid, { call: name, args = {} }, { band, bandMargin, strip }) {
  switch (name) {
    case "create": return tree.create(args.card, args.side, undefined, false);
    case "split": return { card: tree.split(args.card, args.side, undefined) };
    case "close": tree.close(args.card); return { closed: true };
    case "dissolve": tree.dissolve(args.group); return { dissolved: true };
    case "rename": return { group: args.group, name: tree.rename(args.group, args.name) };
    case "leader": return { card: args.card, group: tree.setLeader(args.card) };
    case "move": tree.move(args.card, args.target, args.side); return { card: args.card };
    case "add": return { card: tree.addCard(args.group, undefined) };
    case "grid":
      // The lines of the grid and its cards in the order of the tree with their place and whether they are fixed, as the cases write them.
      return { xs: grid.lines("x"), ys: grid.lines("y"),
        cards: grid.cards.map(({ id, c0, c1, r0, r1, fixed }) => ({ id, c0, c1, r0, r1, fixed })) };
    case "stored": return tree.stored();
    case "rect": return tree.rect(args.card);
    case "path": return tree.path(args.card);
    case "level": return tree.level(args.card);
    // The target search measures the bands of the case and no tab strip, as the cases give no card a tab strip.
    // A drop measures the tab strip of the case, none without one, and moving "group" is the drop of a dragged group card.
    case "drop": {
      if (args.moving !== undefined && args.moving !== "group") throw new Error(`unknown moving ${args.moving}`);
      return tree.targetAt(args.x, args.y, { headerPx: strip ?? 0, edge: 0.25, band, bandMargin, group: args.moving === "group" });
    }
    // A drag runs its points in order with the anchor that each point leaves to the next, and answers the target at the last point.
    case "drag": {
      let hit = null, anchor = null;
      for (const [x, y] of args.points) ({ hit, anchor } = tree.dragAt(anchor, x, y, { headerPx: strip ?? 0, edge: 0.25, band, bandMargin }));
      return hit;
    }
    // default: a balance step without arrange balances without the even arrangement.
    case "balance": tree.balance(args.arrange ?? false); return null;
    case "boundary": return { position: tree.moveBoundary(args.axis, args.line, args.position, false) };
  }
  throw new Error(`unknown call ${name}`);
}

for (const kase of file.cases) {
  test(`groups: ${kase.name}`, () => {
    const { gap, minSize, head, width, height } = kase.options;
    const grid = new Soksak(undefined, { gap, minSize, width, height });
    const read = () => readGroupTree(structuredClone(kase.layout), { gap, minSize, head }, grid);
    if (Object.hasOwn(kase, "throws")) {
      assert.throws(read, (error) => error.message === kase.throws, `the read does not throw ${kase.throws}`);
      return;
    }
    const tree = read();
    kase.steps.forEach((step, i) => {
      const where = `step ${i + 1} ${step.call}`;
      if (Object.hasOwn(step, "throws")) {
        assert.throws(() => call(tree, grid, structuredClone(step), kase.options), (error) => error.message === step.throws, `${where}: does not throw ${step.throws}`);
        return;
      }
      const value = call(tree, grid, structuredClone(step), kase.options);
      // A step without returns, such as balance, answers no value.
      if (!Object.hasOwn(step, "returns")) return;
      const found = difference(JSON.parse(JSON.stringify(value)), step.returns, where);
      assert.equal(found, null, found);
    });
  });
}
