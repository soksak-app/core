// Seeded random operation sequences on the group tree of the page workbench, packages/workbench/group-tree.js, which check after every
// operation the form of a space with groups (docs/spec/groups.md#model): no paidBy record, no line that no card uses, no two lines at one
// coordinate of a slot without a px size, every group card holding exactly the cells of its rectangle and at least two members, and two
// group cards disjoint or one inside the other. A failing seed is reported with its operations, so it becomes a case of
// docs/spec/cases/layout/groups.json.
import assert from "node:assert/strict";
import test from "node:test";
import { Soksak } from "soksak";
import { readGroupTree } from "../group-tree.js";

const OPTIONS = { gap: 12, minSize: 96, head: 28 };
const WIDTH = 1600;
const HEIGHT = 1200;
const SIDES = ["left", "right", "top", "bottom"];
const SEEDS = 120;
const STEPS = 60;

/**
 * The seeded generator mulberry32. Node has no seeded random generator and the workspace declares no property-testing library, so the
 * test carries this one function to repeat a sequence from its seed.
 */
function random(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The group nodes of a stored tree, each with the content cards inside it. */
function groupsOf(stored) {
  const out = [];
  const walk = (node) => {
    const cards = [];
    for (const member of node.members) {
      if (typeof member === "string") cards.push(member);
      else cards.push(...walk(member));
    }
    out.push({ card: node.card, members: node.members.length, cards });
    return cards;
  };
  stored.groups.forEach(walk);
  return out;
}

/** The first breach of the form of a space with groups, or null. */
function breach(tree) {
  const { state, groups: stored } = tree.stored();
  const groups = groupsOf({ groups: stored });
  if (!groups.length) return null;
  const paid = Object.keys(state.paidBy ?? {});
  if (paid.length) return `paidBy record of ${paid[0]}`;
  for (const [axis, lines, lo, hi, size] of [["x", state.xs, "c0", "c1", "width"], ["y", state.ys, "r0", "r1", "height"]]) {
    const used = new Set(state.cards.flatMap((card) => [card[lo], card[hi]]));
    const unused = lines.findIndex((_, k) => !used.has(k));
    if (unused >= 0) return `${axis} line ${unused} is used by no card`;
    for (let k = 0; k + 1 < lines.length; k++) {
      const sized = state.cards.some((card) => card[lo] === k && card[hi] === k + 1 && card[size] !== undefined);
      if (!sized && !(lines[k + 1] > lines[k])) return `${axis} lines ${k} and ${k + 1} stand at one coordinate`;
    }
  }
  const byId = new Map(state.cards.map((card) => [card.id, card]));
  const boxes = groups.map(({ card, members, cards }) => {
    if (members < 2) return { error: `group ${card} has ${members} member` };
    const held = cards.map((id) => byId.get(id));
    if (held.some((entry) => !entry)) return { error: `group ${card} holds a card that is not in the grid` };
    const box = {
      card, c0: Math.min(...held.map((c) => c.c0)), c1: Math.max(...held.map((c) => c.c1)),
      r0: Math.min(...held.map((c) => c.r0)), r1: Math.max(...held.map((c) => c.r1)),
    };
    const inside = state.cards.filter((c) => c.c0 >= box.c0 && c.c1 <= box.c1 && c.r0 >= box.r0 && c.r1 <= box.r1).map((c) => c.id);
    if (inside.length !== cards.length || cards.some((id) => !inside.includes(id))) return { error: `group ${card} does not hold exactly its cells` };
    const cells = held.reduce((n, c) => n + (c.c1 - c.c0) * (c.r1 - c.r0), 0);
    if (cells !== (box.c1 - box.c0) * (box.r1 - box.r0)) return { error: `group ${card} does not cover its rectangle` };
    return box;
  });
  const failed = boxes.find((box) => box.error);
  if (failed) return failed.error;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const apart = a.c1 <= b.c0 || b.c1 <= a.c0 || a.r1 <= b.r0 || b.r1 <= a.r0;
      const holds = (p, q) => p.c0 <= q.c0 && p.c1 >= q.c1 && p.r0 <= q.r0 && p.r1 >= q.r1;
      if (!apart && !holds(a, b) && !holds(b, a)) return `groups ${a.card} and ${b.card} overlap`;
    }
  }
  return null;
}

/** One random operation on the tree, as a record of its call; a refusal of the tree is an answer, not a failure. */
function step(tree, grid, next) {
  const pick = (list) => list[Math.floor(next() * list.length)];
  const cards = grid.cards.map((card) => card.id);
  const groups = tree.nodes().map((node) => node.card);
  const any = [...cards, ...groups];
  const kind = pick(["create", "create", "split", "split", "close", "move", "dissolve", "leader", "boundary", "drop", "balance"]);
  const call = (() => {
    switch (kind) {
      case "create": return { call: kind, args: { card: pick(any), side: pick(SIDES) } };
      case "split": return { call: kind, args: { card: pick(any), side: pick(SIDES) } };
      case "close": return { call: kind, args: { card: pick(any) } };
      case "move": return { call: kind, args: { card: pick(any), target: pick(any), side: pick([...SIDES, "centre"]) } };
      case "dissolve": return groups.length ? { call: kind, args: { group: pick(groups) } } : { call: "balance", args: {} };
      case "leader": return { call: kind, args: { card: pick(any) } };
      case "boundary": {
        const axis = pick(["x", "y"]);
        const lines = grid.lines(axis).length;
        if (lines < 3) return { call: "balance", args: {} };
        return { call: kind, args: { axis, line: 1 + Math.floor(next() * (lines - 2)), px: next() * (axis === "x" ? WIDTH : HEIGHT), snap: next() < 0.5 } };
      }
      case "drop": return { call: kind, args: { card: pick(cards), x: next() * WIDTH, y: next() * HEIGHT } };
      default: return { call: "balance", args: {} };
    }
  })();
  const { args } = call;
  try {
    switch (call.call) {
      case "create": tree.create(args.card, args.side, undefined); break;
      case "split": tree.split(args.card, args.side, undefined); break;
      case "close": tree.close(args.card); break;
      case "move": tree.move(args.card, args.target, args.side); break;
      case "dissolve": tree.dissolve(args.group); break;
      case "leader": tree.setLeader(args.card); break;
      case "boundary": tree.moveBoundary(args.axis, args.line, args.px, args.snap); break;
      case "drop": {
        const hit = tree.dropAt(args.x, args.y, { headerPx: OPTIONS.head, footerPx: 0, centreOnly: args.card });
        call.hit = hit;
        if (hit && hit.card !== args.card) tree.move(args.card, hit.card, hit.zone);
        break;
      }
      case "balance": tree.balance(); break;
    }
    call.result = "done";
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError) throw error;
    call.result = error.message;
  }
  return call;
}

for (let seed = 1; seed <= SEEDS; seed++) {
  test(`group form holds after random operations, seed ${seed}`, { timeout: 20000 }, () => {
    const next = random(seed);
    const grid = new Soksak(undefined, { gap: OPTIONS.gap, minSize: OPTIONS.minSize, width: WIDTH, height: HEIGHT });
    const tree = readGroupTree({ state: { xs: [0, 1], ys: [0, 1], cards: [{ id: "card-1", c0: 0, c1: 1, r0: 0, r1: 1 }], paidBy: {} },
      groups: [], leader: "card-1", lastCard: 1 }, OPTIONS, grid);
    const done = [];
    for (let i = 0; i < STEPS; i++) {
      done.push(step(tree, grid, next));
      const found = breach(tree);
      assert.equal(found, null, `seed ${seed} step ${i + 1}: ${found}\noperations: ${JSON.stringify(done)}\nlayout: ${JSON.stringify(tree.stored())}`);
    }
  });
}
