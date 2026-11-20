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

/** The difference in px under which two drawn sizes are one size. */
const SAME = 0.5;
/**
 * The relative difference under which two fractions are one fraction. The rules of sizes work on the fractions of the stored tree
 * (packages/soksak/docs/layout.md#add-and-remove): a drawn size is a fraction of what a level holds after its corridors, and a
 * corridor of a deeper level is drawn inside one kid, so equal fractions are not equal drawn sizes on every level, and ratios of
 * drawn sizes are not the ratios that the rules keep.
 */
const ULP = 1e-9;
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
 * The stored tree of a state: a node is {id} for a card or a box, or {axis, kids} with the fraction `share` of each kid, and every
 * node has the ids of its cards and boxes.
 */
function treeOf(state, rects) {
  const read = (node) => {
    if (node.cut) {
      const kids = node.kids.map((kid) => ({ ...read(kid.node), share: kid.share }));
      return { axis: node.cut, kids, ids: kids.flatMap((k) => k.ids), cards: kids.flatMap((k) => k.cards) };
    }
    if (node.box) {
      const inner = read(node.inner);
      return { id: node.box, ids: [node.box], cards: inner.cards };
    }
    return { id: node.card, ids: [node.card], cards: [node.card] };
  };
  return { root: read(state.root) };
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

const near = (a, b) => Math.abs(a - b) <= ULP * Math.max(1, Math.abs(a), Math.abs(b));

/** A cut is even when its kids have one fraction; the generated cards have no px size, so every kid takes a fraction. */
const evenCut = (cut) => cut.kids.every((kid) => near(kid.share, cut.kids[0].share));

/** The two stored trees have the same nodes in the same order and the same fractions. */
function sameTree(a, b) {
  if (a.card !== undefined || b.card !== undefined) return a.card === b.card;
  if (a.box !== undefined || b.box !== undefined) return a.box === b.box && sameTree(a.inner, b.inner);
  return a.cut === b.cut && a.kids.length === b.kids.length && a.kids.every((kid, i) => near(kid.share, b.kids[i].share) && sameTree(kid.node, b.kids[i].node));
}

/** Every cell of the grid is covered by exactly one card. */
function tiles(grid) {
  const [xs, ys, cards] = [grid.lines("x"), grid.lines("y"), grid.cards];
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
  const grid = new Soksak({ root: { card: "c1" } }, file.options);
  const failures = Object.fromEntries(file.checked.map((name) => [name, []]));
  let next = 2;
  const fail = (name, step, text) => failures[name].push(`seed ${seed} step ${step}: ${text}`);
  const pick = () => grid.cards[Math.floor(random() * grid.cards.length)].id;
  const side = () => SIDES[Math.floor(random() * 4)];
  const judge = (step, change, check) => {
    const state = grid.toJSON();
    const rects = grid.rects();
    try {
      change();
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
    const before = treeOf(state, rects);
    const after = treeOf(grid.toJSON(), grid.rects());
    const was = holderOf(before.root, [target]);
    const along = was && was.axis === axis;
    const now = holderOf(after.root, [id]);
    if (!now) return fail("I7", step, `card ${id} is in no cut`);
    if (along) {
      const kept = now.kids.filter((kid) => !kid.ids.includes(id));
      const old = new Map(was.kids.map((kid) => [key(kid.ids), kid]));
      const evenBefore = evenCut(was);
      const factors = kept.map((kid) => {
        const prior = old.get(key(kid.ids));
        return prior ? kid.share / prior.share : NaN;
      });
      if (evenBefore) {
        if (factors.some((f) => Number.isNaN(f) || !near(f, factors[0]))) fail("I7", step, `the even cut of ${target} changed its ratios: ${factors}`);
        if (!evenCut(now)) fail("I7", step, `the even cut of ${target} is not even after the add of ${id}`);
      } else {
        const others = kept.filter((kid) => !kid.ids.includes(target));
        const changed = others.filter((kid) => !near(kid.share, old.get(key(kid.ids)).share));
        if (changed.length) fail("I7", step, `the add of ${id} beside ${target} in an uneven cut changed ${changed.map((k) => k.ids)}`);
        const pair = now.kids.filter((kid) => kid.ids.includes(target) || kid.ids.includes(id)).map((kid) => kid.share);
        const paid = old.get(key([target])).share;
        if (pair.length !== 2 || !near(pair[0], pair[1]) || !near(pair[0] + pair[1], paid)) fail("I7", step, `the add of ${id} does not take half of ${target}: ${pair} of ${paid}`);
      }
      const outside = moved(rects, grid, now.ids);
      if (outside.length) fail("I8", step, `the add of ${id} moved ${outside} outside its cut`);
    } else {
      const pair = now.kids.map((kid) => kid.share);
      if (now.kids.length !== 2 || !near(pair[0], pair[1])) fail("I7", step, `the wrap of ${target} is not two halves: ${pair}`);
      const outside = moved(rects, grid, now.ids);
      if (outside.length) fail("I8", step, `the wrap of ${target} moved ${outside}`);
    }
    // I10: the withdraw of the card just added restores the stored tree of an even cut and of a wrap, and with it the rectangles.
    if (!along || evenCut(was)) {
      const copy = new Soksak(grid.toJSON(), file.options);
      try {
        copy.withdraw(id);
        if (!sameTree(copy.toJSON().root, state.root)) fail("I10", step, `the withdraw of ${id} does not restore the tree`);
        const back = moved(rects, copy, []);
        if (back.length) fail("I10", step, `the withdraw of ${id} does not restore ${back}`);
      } catch (error) {
        fail("I10", step, `the withdraw of ${id} is refused: ${error.message}`);
      }
    }
  };
  /** The checks of a withdraw of id, on the tree that the withdraw reads. */
  const withdrawn = (step, id) => (state, rects) => {
    const before = treeOf(state, rects);
    const after = treeOf(grid.toJSON(), grid.rects());
    const was = holderOf(before.root, [id]);
    if (!was) return;
    const rest = was.kids.filter((kid) => !kid.ids.includes(id));
    if (rest.length > 1) {
      const factors = rest.map((kid) => {
        const now = holderOf(after.root, kid.ids)?.kids.find((k) => key(k.ids) === key(kid.ids));
        return now ? now.share / kid.share : NaN;
      });
      if (factors.some((f) => Number.isNaN(f) || !near(f, factors[0]))) fail("I7", step, `the withdraw of ${id} changed the ratios of its cut: ${factors}`);
    }
    const outside = moved(rects, grid, was.ids);
    if (outside.length) fail("I8", step, `the withdraw of ${id} moved ${outside} outside its cut`);
  };
  for (let step = 1; step <= file.steps; step++) {
    const u = random();
    const count = grid.cards.length;
    if (u < 0.45) {
      const target = pick();
      const to = side();
      const id = `c${next++}`;
      judge(step, () => grid.insert(target, to, { card: id }), inserted(step, id, target, to));
    } else if (u < 0.7) {
      const id = pick();
      if (count > 1) judge(step, () => grid.withdraw(id), withdrawn(step, id));
    } else if (u < 0.9) {
      const id = pick();
      const target = pick();
      const to = side();
      if (count > 1 && target !== id) {
        let left = null;
        const start = grid.toJSON();
        if (judge(step, () => { left = grid.withdraw(id); }, withdrawn(step, id))) {
          // A move is one change: a refused landing leaves the layout as it was before the withdraw.
          if (!judge(step, () => grid.insert(target, to, left), inserted(step, id, target, to))) grid.replace(start);
        }
      }
    } else {
      judge(step, () => grid.even(), (_state) => {
        const after = treeOf(grid.toJSON(), grid.rects());
        const uneven = [];
        const visit = (node) => {
          if (!node.kids) return;
          if (!evenCut(node)) uneven.push(key(node.ids));
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
  console.log(`failures per invariant: ${JSON.stringify(counts)}`);
  for (const [name, list] of Object.entries(total)) for (const text of list) console.log(`${name} ${text}`);
  for (const [name, list] of Object.entries(total)) assert.equal(list.length, 0, `${name}: ${list.slice(0, 5).join("; ")}`);
});
