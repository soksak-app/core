import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Soksak } from "../dist/index.js";

/**
 * The invariants of the rule of sizes over generated layouts
 * (docs/spec/cases/layout/invariants.json). The Go layout model of
 * packages/workbench-mygo runs the same file with the same generator, so a
 * seed makes the same operations in both languages.
 */
const file = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/layout/invariants.json", import.meta.url), "utf8"));

/** The difference in px under which two drawn sizes are one size, as the layout library judges an even cut. */
const SAME = 0.5;
/** The difference in px under which a rectangle that an operation does not change is unchanged. */
const KEPT = 1e-6;
const SIDES = ["left", "right", "top", "bottom"];

/** mulberry32: the numbers of the generator in [0, 1), the same in every language of the cases. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The slicing tree of the grid, the cut of prefer[0] taken first where the lines allow both: a node is {id} for a card or {axis, kids},
 * and every node has the ids of its cards and its drawn extent.
 */
function treeOf(grid, prefer) {
  const { xs, ys, cards } = grid.toJSON();
  const rects = grid.rects();
  const leaves = cards.map((card) => ({ id: card.id, ids: [card.id], at: { x0: xs[card.c0], x1: xs[card.c1], y0: ys[card.r0], y1: ys[card.r1] } }));
  const ends = { x: ["x0", "x1"], y: ["y0", "y1"] };
  const build = (nodes) => {
    if (nodes.length === 1) return nodes[0];
    for (const axis of prefer) {
      const [lo, hi] = ends[axis];
      const end = Math.max(...nodes.map((n) => n.at[hi]));
      const at = [...new Set(nodes.map((n) => n.at[hi]))].filter((v) => v < end && nodes.every((n) => n.at[hi] <= v || n.at[lo] >= v)).sort((p, q) => p - q);
      if (!at.length) continue;
      const bounds = [Math.min(...nodes.map((n) => n.at[lo])), ...at, end];
      const kids = [];
      for (let i = 0; i + 1 < bounds.length; i++) kids.push(build(nodes.filter((n) => n.at[lo] >= bounds[i] && n.at[hi] <= bounds[i + 1])));
      return { axis, kids, ids: kids.flatMap((k) => k.ids), at: { x0: Math.min(...kids.map((k) => k.at.x0)), x1: Math.max(...kids.map((k) => k.at.x1)), y0: Math.min(...kids.map((k) => k.at.y0)), y1: Math.max(...kids.map((k) => k.at.y1)) } };
    }
    throw new Error("the grid is not a slicing arrangement");
  };
  const size = (node, axis) => {
    const rs = node.ids.map((id) => rects.get(id));
    return axis === "x" ? Math.max(...rs.map((r) => r.x + r.w)) - Math.min(...rs.map((r) => r.x)) : Math.max(...rs.map((r) => r.y + r.h)) - Math.min(...rs.map((r) => r.y));
  };
  return { root: build(leaves), size };
}

/** The cut that holds the node whose ids are ids, or null. */
function holderOf(node, ids) {
  if (!node.kids) return null;
  for (const kid of node.kids) {
    if (kid.ids.length === ids.length && ids.every((id) => kid.ids.includes(id))) return node;
    const found = holderOf(kid, ids);
    if (found) return found;
  }
  return null;
}

const key = (ids) => [...ids].sort().join(",");

/** The coordinates at which the children of a cut meet. */
const inner = (cut) => cut.kids.slice(1).map((kid) => kid.at[cut.axis === "x" ? "x0" : "y0"]);

/**
 * Whether the lines of the grid read as more than one slicing tree: two neighbouring children of a cut are cuts along the other axis
 * whose children meet at one coordinate, so the line through both also divides the parent across, and the grid has lost which of the
 * trees an operation made (docs/plans/layout-sizes.md#model).
 */
function ambiguous(grid) {
  const visit = (node) => {
    if (!node.kids) return false;
    for (let i = 0; i + 1 < node.kids.length; i++) {
      const [p, q] = [node.kids[i], node.kids[i + 1]];
      if (p.kids && q.kids && p.axis === q.axis && inner(p).some((v) => inner(q).includes(v))) return true;
    }
    return node.kids.some(visit);
  };
  return visit(treeOf(grid, ["x", "y"]).root) || visit(treeOf(grid, ["y", "x"]).root);
}
const evenCut = (tree, cut) => cut.kids.every((kid) => Math.abs(tree.size(kid, cut.axis) - tree.size(cut.kids[0], cut.axis)) < SAME);

/** Every cell of the grid is covered by exactly one card. */
function tiles(grid) {
  const { xs, ys, cards } = grid.toJSON();
  const count = new Map();
  for (const card of cards) for (let c = card.c0; c < card.c1; c++) for (let r = card.r0; r < card.r1; r++) count.set(`${c}:${r}`, (count.get(`${c}:${r}`) ?? 0) + 1);
  for (let c = 0; c + 1 < xs.length; c++) for (let r = 0; r + 1 < ys.length; r++) if (count.get(`${c}:${r}`) !== 1) return `cell ${c}:${r} is covered ${count.get(`${c}:${r}`) ?? 0} times`;
  return null;
}

/** The cards outside keep whose rectangle differs from before. */
function moved(before, grid, keep) {
  const now = grid.rects();
  return [...before].filter(([id, r]) => !keep.includes(id) && now.has(id) && ["x", "y", "w", "h"].some((k) => Math.abs(now.get(id)[k] - r[k]) > KEPT)).map(([id]) => id);
}

/** Runs the operations of one seed and returns the failures of each invariant with their texts. */
function run(seed) {
  const random = generator(seed);
  const grid = new Soksak({ xs: [0, 1], ys: [0, 1], cards: [{ id: "c1", c0: 0, c1: 1, r0: 0, r1: 1 }] }, file.options);
  const failures = Object.fromEntries(file.checked.map((name) => [name, []]));
  let next = 2;
  // A failure records whether the layout before or after the operation reads as two trees.
  let twoTrees = false;
  const fail = (name, step, text) => failures[name].push({ text: `seed ${seed} step ${step}: ${text}`, twoTrees });
  const pick = () => grid.toJSON().cards[Math.floor(random() * grid.toJSON().cards.length)].id;
  const side = () => SIDES[Math.floor(random() * 4)];
  const judge = (step, change, check) => {
    const state = grid.toJSON();
    const rects = grid.rects();
    twoTrees = ambiguous(grid);
    try {
      change();
      twoTrees ||= ambiguous(grid);
    } catch (error) {
      if (JSON.stringify(grid.toJSON()) !== JSON.stringify(state)) fail("I2", step, `the refusal ${error.message} changed the layout`);
      return false;
    }
    const broken = tiles(grid);
    if (broken) fail("I1", step, broken);
    for (const [id, r] of grid.rects()) {
      const was = rects.get(id);
      const changed = !was || ["x", "y", "w", "h"].some((k) => Math.abs(was[k] - r[k]) > KEPT);
      if (changed && (r.w < file.options.minSize - SAME || r.h < file.options.minSize - SAME)) fail("I2", step, `card ${id} is drawn ${r.w}x${r.h}`);
    }
    check(state, rects);
    return true;
  };
  /** The checks of an insert of id beside target toward to, on the tree that the insert reads. */
  const inserted = (step, id, target, to) => (state, rects) => {
    const axis = to === "left" || to === "right" ? "x" : "y";
    const prefer = axis === "x" ? ["y", "x"] : ["x", "y"];
    const before = treeOf(new Soksak(state, file.options), prefer);
    const after = treeOf(grid, prefer);
    const was = holderOf(before.root, [target]);
    const along = was && was.axis === axis;
    const now = holderOf(after.root, [id]);
    if (!now) return fail("I7", step, `card ${id} is in no cut`);
    if (along) {
      const kept = now.kids.filter((kid) => !kid.ids.includes(id));
      const old = new Map(was.kids.map((kid) => [key(kid.ids), kid]));
      const evenBefore = evenCut(before, was);
      const factors = kept.map((kid) => {
        const prior = old.get(key(kid.ids));
        return prior ? after.size(kid, axis) / before.size(prior, axis) : NaN;
      });
      if (evenBefore) {
        if (factors.some((f) => Number.isNaN(f) || Math.abs(f - factors[0]) > 1e-6)) fail("I7", step, `the even cut of ${target} changed its ratios: ${factors}`);
        if (!evenCut(after, now)) fail("I7", step, `the even cut of ${target} is not even after the add of ${id}`);
      } else {
        const others = kept.filter((kid) => !kid.ids.includes(target));
        const changed = others.filter((kid) => Math.abs(after.size(kid, axis) - before.size(old.get(key(kid.ids)), axis)) > SAME);
        if (changed.length) fail("I7", step, `the add of ${id} beside ${target} in an uneven cut changed ${changed.map((k) => k.ids)}`);
      }
      const outside = moved(rects, grid, now.ids);
      if (outside.length) fail("I8", step, `the add of ${id} moved ${outside} outside its cut`);
    } else {
      const pair = now.kids.map((kid) => after.size(kid, axis));
      if (now.kids.length !== 2 || Math.abs(pair[0] - pair[1]) > SAME) fail("I7", step, `the wrap of ${target} is not two halves: ${pair}`);
      const outside = moved(rects, grid, now.ids);
      if (outside.length) fail("I8", step, `the wrap of ${target} moved ${outside}`);
    }
    // I10: the withdraw of the card just added restores the layout of an even cut and of a wrap.
    if (!along || evenCut(before, was)) {
      const copy = new Soksak(grid.toJSON(), file.options);
      try {
        copy.withdraw([], id);
        const back = moved(rects, copy, []);
        if (back.length) fail("I10", step, `the withdraw of ${id} does not restore ${back}`);
      } catch (error) {
        fail("I10", step, `the withdraw of ${id} is refused: ${error.message}`);
      }
    }
  };
  /** The checks of a withdraw of id, on the tree that the withdraw reads. */
  const withdrawn = (step, id) => (state, rects) => {
    const prefer = grid.fillOrder === "v" ? ["x", "y"] : ["y", "x"];
    const before = treeOf(new Soksak(state, file.options), prefer);
    const after = treeOf(grid, prefer);
    const was = holderOf(before.root, [id]);
    if (!was) return;
    const rest = was.kids.filter((kid) => !kid.ids.includes(id));
    if (rest.length > 1) {
      const factors = rest.map((kid) => {
        const now = holderOf(after.root, kid.ids)?.kids.find((k) => key(k.ids) === key(kid.ids));
        return now ? after.size(now, was.axis) / before.size(kid, was.axis) : NaN;
      });
      if (factors.some((f) => Number.isNaN(f) || Math.abs(f - factors[0]) > 1e-6)) fail("I7", step, `the withdraw of ${id} changed the ratios of its cut: ${factors}`);
    }
    const outside = moved(rects, grid, was.ids);
    if (outside.length) fail("I8", step, `the withdraw of ${id} moved ${outside} outside its cut`);
  };
  for (let step = 1; step <= file.steps; step++) {
    const u = random();
    const count = grid.toJSON().cards.length;
    if (u < 0.45) {
      const target = pick();
      const to = side();
      const id = `c${next++}`;
      judge(step, () => grid.insert([], target, to, { id }), inserted(step, id, target, to));
    } else if (u < 0.7) {
      const id = pick();
      if (count > 1) judge(step, () => grid.withdraw([], id), withdrawn(step, id));
    } else if (u < 0.9) {
      const id = pick();
      const target = pick();
      const to = side();
      if (count > 1 && target !== id) {
        let left = null;
        const start = grid.toJSON();
        if (judge(step, () => { left = grid.withdraw([], id); }, withdrawn(step, id))) {
          // A move is one change: a refused landing leaves the layout as it was before the withdraw.
          if (!judge(step, () => grid.insert([], target, to, left), inserted(step, id, target, to))) grid.replace(start);
        }
      }
    } else {
      judge(step, () => grid.even([]), (_state) => {
        const after = treeOf(grid, ["x", "y"]);
        const uneven = [];
        const visit = (node) => {
          if (!node.kids) return;
          if (!evenCut(after, node)) uneven.push(key(node.ids));
          node.kids.forEach(visit);
        };
        visit(after.root);
        if (uneven.length) fail("I7", step, `even left the cuts ${uneven.join(" | ")} uneven`);
      });
    }
  }
  return failures;
}

test("the invariants of the rule of sizes hold over the generated layouts of every seed", { timeout: 60000 }, () => {
  const total = Object.fromEntries(file.checked.map((name) => [name, []]));
  for (const seed of file.seeds) for (const [name, list] of Object.entries(run(seed))) total[name].push(...list);
  const counts = Object.fromEntries(Object.entries(total).map(([name, list]) => [name, list.length]));
  const oneTree = Object.fromEntries(Object.entries(total).map(([name, list]) => [name, list.filter((f) => !f.twoTrees).length]));
  console.log(`failures per invariant: ${JSON.stringify(counts)}; on layouts whose lines read as one tree: ${JSON.stringify(oneTree)}`);
  for (const [name, list] of Object.entries(total)) for (const f of list) console.log(`${name}${f.twoTrees ? " two trees" : ""} ${f.text}`);
  for (const [name, list] of Object.entries(total)) assert.equal(list.length, 0, `${name}: ${list.slice(0, 5).map((f) => f.text).join("; ")}`);
});
