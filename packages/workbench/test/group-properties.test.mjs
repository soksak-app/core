// Seeded random operation sequences on the group tree of the page workbench, packages/workbench/group-tree.js, which check after every
// operation the form of a space with groups (docs/spec/groups.md#model): the stored layout reads back with the refusals of the storage,
// the boxes of the tree are the group cards that the tree records, with their names, leaders and members, and every card is drawn with
// an area. A failing seed is reported with its operations, so it becomes a case of
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

/** A level of group nodes as a comparable form: each group card with its name, its leader and its members, sorted by id. */
function form(members) {
  return members.map((member) => (typeof member === "string" ? member
    : { card: member.card, name: member.name, leader: member.leader, members: form(member.members) }))
    .sort((a, b) => (typeof a === "string" ? a : a.card).localeCompare(typeof b === "string" ? b : b.card));
}

/**
 * The first breach of the form of a space with groups, or null: the stored layout reads back with the refusals of the storage, its boxes
 * are the group cards of the record of the tree with the same names, leaders and members, and every content card is drawn with an area.
 */
function breach(tree, grid) {
  const stored = tree.stored();
  let read;
  try {
    read = readGroupTree(structuredClone(stored), OPTIONS, new Soksak(undefined, { gap: OPTIONS.gap, minSize: OPTIONS.minSize, width: WIDTH, height: HEIGHT }));
  } catch (error) {
    return `the stored layout is refused: ${error.message}`;
  }
  const kept = JSON.stringify(form(tree.groups));
  const boxes = JSON.stringify(form(read.groups));
  if (kept !== boxes) return `the group record ${kept} is not the boxes ${boxes}`;
  if (read.rootLeader !== tree.rootLeader) return `the root leader ${tree.rootLeader} is stored as ${read.rootLeader}`;
  for (const [id, r] of grid.rects()) if (!(r.w > 0 && r.h > 0)) return `card ${id} is drawn ${r.w}x${r.h}`;
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
        // The drop of the card is the move to the add that the target search gives; a strip or a centre moves no card.
        const hit = tree.targetAt(args.x, args.y, { headerPx: OPTIONS.head, edge: 0.25, band: 5, bandMargin: 3 });
        call.hit = hit;
        if (hit?.kind === "add") tree.move(args.card, hit.target, hit.side);
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
    const tree = readGroupTree({ state: { root: { card: "card-1" } },
      leader: "card-1", lastCard: 1 }, OPTIONS, grid);
    const done = [];
    for (let i = 0; i < STEPS; i++) {
      done.push(step(tree, grid, next));
      const found = breach(tree, grid);
      assert.equal(found, null, `seed ${seed} step ${i + 1}: ${found}\noperations: ${JSON.stringify(done)}\nlayout: ${JSON.stringify(tree.stored())}`);
    }
  });
}
