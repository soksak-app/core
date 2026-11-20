// I3, I4, I5, I6 and I9 of docs/spec/groups.md#invariants on the page workbench, over layouts that a seeded generator makes from the plane of
// arrange(). The layouts are made once, before the tests run, so this file holds no other test: the generation leaves the state of the
// page modules, which a test of another file does not share.
import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { CHROME } from "../chrome-metrics.js";
import { arrange, PLAIN, plane, pointer, run, status } from "./support/group-page.mjs";

/**
 * The seeded generator mulberry32. Node has no seeded random generator and the workspace declares no property-testing library, so the
 * test carries this one function to repeat a layout from its seed, as the invariant checks of the layout library do.
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

const SIDES = ["left", "right", "top", "bottom"];
/** The step in points of the grid of points over the plane at which each drop is resolved. */
const POINT_STEP = 24;
/** The number of generated layouts. */
const SEEDS = 3;

/**
 * Builds the layout of seed from arrange(): each step splits a content card, groups it, or adds a tab to it, chosen by the generator;
 * a step that the layout refuses is counted and leaves the layout as it was.
 */
async function generated(seed, steps) {
  arrange();
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  let refused = 0;
  for (let i = 0; i < steps; i += 1) {
    const card = pick(plane.currentGrid().cards.map((c) => c.id));
    const kind = next();
    const call = kind < 0.45 ? ["core.card.split", { card, side: pick(SIDES), plugin: PLAIN }]
      : kind < 0.7 ? ["core.group.create", { card, side: pick(SIDES), plugin: PLAIN }]
      : ["core.card.add-tab", { card, plugin: PLAIN }];
    try {
      await run(...call);
    } catch {
      // silent: a refused step is a generated layout that the rule does not allow; the count of refusals is reported with the failures.
      refused += 1;
    }
  }
  return refused;
}

/** The tabs of a stored node by their identifiers, each the JSON text of its plugin and its params. */
function storedTabs(node) {
  if (node.cut) return Object.assign({}, ...node.kids.map((kid) => storedTabs(kid.node)));
  if (node.box !== undefined) return storedTabs(node.inner);
  // default: an empty card stores no data and holds no tab.
  return Object.fromEntries((node.data?.tabs ?? []).map((t) => [t.id, JSON.stringify([t.plugin, t.params])]));
}

/** The group cards of a stored node by their identifiers. */
function groupCards(node) {
  if (node.cut) return node.kids.flatMap((kid) => groupCards(kid.node));
  if (node.box !== undefined) return [node.box, ...groupCards(node.inner)];
  return [];
}

/** The distinct drop targets of the drag of source over the grid of points: of a tab by dragHit, of a group card by groupDragHit. */
function distinctHits(source) {
  const band = plane.dropBands();
  const hits = new Map();
  for (let y = POINT_STEP / 2; y < 1200; y += POINT_STEP) {
    for (let x = POINT_STEP / 2; x < 1600; x += POINT_STEP) {
      const { hit } = source.group ? plane.groupDragHit(null, source.id, x, y, band) : plane.dragHit(null, x, y, band, source.id);
      if (hit && !hits.has(JSON.stringify(hit))) hits.set(JSON.stringify(hit), { hit, x, y });
    }
  }
  return [...hits.values()];
}

/**
 * The drop of source at x, y through the pointer on its tab or its header: the preview that core.drag reports there, after which the
 * pointer leaves the plane, so the release runs nothing, and the command that the release would run is run with the target of the drag.
 * Returns {target, preview, before, after, rect, name, reply}: the stored layout before and after, the drawn rectangle of the card that
 * holds the dragged tab, or of the dragged group card, after the drop, and the command that ran with its reply.
 */
async function dropAt(source, x, y) {
  const before = (await status("core.layout")).state;
  const element = source.group ? document.querySelector(`.group[data-group-card="${source.id}"] > .group__head`)
    : document.querySelector(`.tab[data-tab-id="${source.id}"]`);
  pointer(element, "pointerdown", -100, -100);
  pointer(element, "pointermove", x, y);
  const { target, preview } = await status("core.drag");
  pointer(element, "pointermove", -100, -100);
  pointer(element, "pointerup", -100, -100);
  let name = null, reply;
  if (target) {
    if (source.group) [name, reply] = ["core.card.move", await run("core.card.move", { card: source.id, target: target.card, side: target.zone })];
    else [name, reply] = ["core.tab.move", await run("core.tab.move", { tab: source.id, ...target })];
  }
  const holder = source.group ? source.id : plane.currentGrid().cards.find((c) => plane.tabsOf(c).some((t) => t.id === source.id)).id;
  return { target, preview, before, after: (await status("core.layout")).state, rect: plane.currentTree().rect(holder), name, reply };
}

// I3, I5, I6 and I9 of docs/spec/groups.md#invariants on the page: over generated layouts, for every tab and every group card and every
// distinct target of the points of the plane, the preview that core.drag shows is the drawn rectangle of the result, the drop keeps every
// tab with its plugin and params, a drop of a card that moves whole on its vacated slot leaves the stored layout as it was, and the
// command of the release, run again with the identifiers of its reply, answers the same and changes nothing. Each source
// of each layout is one test with its own time limit; the layouts are generated once, before the tests run, and each test adopts a copy.
// The node test runner starts a registered test while the module still awaits, so every layout is made before the first test is
// registered; a generation that ran beside a test would change the plane under its drops.
const layouts = [];
for (let seed = 1; seed <= SEEDS; seed += 1) {
  const refused = await generated(seed, 6);
  // The stored layout shares the data of the cards, which a drop changes, so each test and each restore adopts a copy of it.
  const kept = structuredClone(plane.capture());
  const sources = [
    ...plane.currentGrid().cards.flatMap((card) => plane.tabsOf(card).map((t) => ({ id: t.id, card: card.id, alone: plane.tabsOf(card).length === 1 }))),
    ...plane.currentTree().order().filter((entry) => entry.node).map((entry) => ({ id: entry.id, card: entry.id, group: true, alone: true })),
  ];
  layouts.push({ seed, refused, kept, sources });
}
for (const { seed, refused, kept, sources } of layouts) {
  for (const source of sources) {
    test(`over the generated layout of seed ${seed}, the preview of every drop of ${source.id} is its result, it keeps every tab, a drop on its vacated place changes nothing and a repeat with its reply changes nothing`, { timeout: 50000 }, async () => {
      plane.adopt(structuredClone(kept), "spc-aaaaaa");
      const failures = [];
      const hits = distinctHits(source);
      for (const { hit, x, y } of hits) {
        // A card that moves whole, a content card with one tab or a group card, vacates its slot (docs/spec/groups.md#vacated-slot).
        const vacated = source.alone && plane.currentGrid().vacates(source.card, hit.card, hit.zone);
        const { target, preview, before, after, rect, name, reply } = await dropAt(source, x, y);
        const where = `${JSON.stringify(hit)} at ${x}, ${y}`;
        if (target && JSON.stringify(preview) !== JSON.stringify(rect)) failures.push(`I3 ${where}: preview ${JSON.stringify(preview)}, result ${JSON.stringify(rect)}`);
        const [held, now] = [storedTabs(before.root), storedTabs(after.root)];
        if (!isDeepStrictEqual(held, now)) failures.push(`I5 ${where}: the tabs ${JSON.stringify(held)} became ${JSON.stringify(now)}`);
        if (vacated && JSON.stringify(after) !== JSON.stringify(before)) failures.push(`I6 ${where}: the drop on the vacated place changed the layout`);
        // A move of a group card to the centre of a content card is an exchange, a toggle that no repeat can find, so I9 does not judge
        // it; every other command is repeated with the identifiers of its reply (docs/spec/groups.md#idempotency).
        const exchange = source.group && hit.zone === "centre" && !groupCards(before.root).includes(hit.card);
        if (target && !exchange) {
          try {
            const again = await run(name, reply);
            const changed = JSON.stringify((await status("core.layout")).state) !== JSON.stringify(after);
            if (!isDeepStrictEqual(again, reply) || changed) failures.push(`I9 ${where}: the repeat of ${name} with its reply ${JSON.stringify(reply)} answered ${JSON.stringify(again)} and changed the layout: ${changed}`);
          } catch (error) {
            failures.push(`I9 ${where}: the repeat of ${name} with its reply ${JSON.stringify(reply)} failed with ${error.message}`);
          }
        }
        plane.adopt(structuredClone(kept), "spc-aaaaaa");
      }
      assert.ok(hits.length > 0, "no drop was judged");
      assert.deepEqual(failures, [], `${failures.length} of ${hits.length} drops failed (${refused} generated steps refused)`);
    });
  }
}


/** The width and the height of the plane of the support, over which the drag paths of I4 move. */
const [WIDTH, HEIGHT] = [1600, 1200];

/** The text of a target of core.drag, with the card as a list and no index as null, as the key of the targets of I4. */
const keyOf = (target) => JSON.stringify([[].concat(target.card), target.zone, target.index ?? null]);

/** The stored layout of core.layout that a result is compared by: its tree, its leader and lastCard. */
async function result() {
  const { state, leader, lastCard } = await status("core.layout");
  return JSON.stringify({ state, leader, lastCard });
}

/**
 * The targets that I4 requires of the drag of source over the stored layout (docs/spec/groups.md#invariants): every side of every node
 * of the tree, a card by its id, a group card by the id of its box and a cut by its members, its window sidebars left out, except a side
 * along the axis of a cut, which is the target of its kid toward that side (packages/soksak/docs/layout.md), the members of such a cut
 * naming the run of all its kids, which no line of a drag holds; the centre of every content card; and, for a tab, the tab strip of every
 * content card at its end. JSDOM lays out no element, so every tab box of a strip stands at 0 with no width, and a point of a strip has
 * the index of its end; the indexes between the tabs are judged by the Go check over drawn tabs. Each vacated slot is among them as a
 * side of the moving node.
 */
function requiredTargets(root, source) {
  const targets = new Map();
  const add = (target) => targets.set(keyOf(target), target);
  const members = (node) => {
    if (node.card !== undefined) return node.fixed ? [] : [node.card];
    if (node.box !== undefined) return [node.box];
    return node.kids.flatMap((kid) => members(kid.node));
  };
  const visit = (node) => {
    const named = members(node);
    if (named.length > 0) {
      for (const side of SIDES) {
        const along = node.cut === "x" && (side === "left" || side === "right") || node.cut === "y" && (side === "top" || side === "bottom");
        if (!along) add({ card: named.length === 1 ? named[0] : named, zone: side });
      }
    }
    if (node.card !== undefined) {
      if (node.fixed) return;
      add({ card: node.card, zone: "centre" });
      if (!source.group) {
        const tabs = (node.data?.tabs ?? []).filter((t) => t.id !== source.id);
        add({ card: node.card, zone: "strip", index: tabs.length });
      }
    } else if (node.box !== undefined) visit(node.inner);
    else node.kids.forEach((kid) => visit(kid.node));
  };
  visit(root);
  return [...targets.values()];
}

/**
 * The targets that the drag of source selects over the plane (docs/spec/groups.md#target-search), through the pointer on its tab or its
 * header. From the middle of each side of each content card and group card, the drag moves inward a point at a time from 16 points
 * outside the line, so it enters every band of the side stack and of the boxes around the card, until it reaches the centre of the card
 * or stays on one target or on none for 12 points inside the line; a tab strip or a group header between the line and the bands is
 * passed. From each band that it enters first, the drag moves along that line to both ends of the plane, which keeps the anchor of the
 * band, so the anchor selects the runs of its cut. The drag enters the centre of each content card, and the drag of a tab moves along
 * the tab strip of each content card 4 points at a time. The drag enters a point fresh by leaving the plane first.
 */
async function reachedTargets(source) {
  const element = source.group ? document.querySelector(`.group[data-group-card="${source.id}"] > .group__head`)
    : document.querySelector(`.tab[data-tab-id="${source.id}"]`);
  const reached = new Map();
  const at = async (x, y, fresh) => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return null;
    if (fresh) pointer(element, "pointermove", -100, -100);
    pointer(element, "pointermove", x, y);
    const { target } = await status("core.drag");
    if (target) reached.set(keyOf(target), target);
    return target;
  };
  const slide = async (x, y, ux, uy) => {
    for (const way of [-1, 1]) {
      await at(x, y, true);
      for (let step = 50; ; step += 50) {
        const [ax, ay] = [x + way * step * ux, y + way * step * uy];
        if (ax < 0 || ay < 0 || ax >= WIDTH || ay >= HEIGHT) break;
        await at(ax, ay, false);
      }
    }
    await at(x, y, true);
  };
  const tree = plane.currentTree();
  const cards = plane.currentGrid().cards.map((card) => card.id);
  const groups = tree.order().filter((entry) => entry.node).map((entry) => entry.id);
  // The tab strip of a content card is the head of the card, head-h of the chrome metrics (docs/spec/settings.md#layout-values).
  const strip = parseFloat(CHROME["head-h"]);
  pointer(element, "pointerdown", -100, -100);
  const slid = new Set();
  for (const id of [...cards, ...groups]) {
    const rect = tree.rect(id);
    const sides = [
      { name: "top", x: rect.x + rect.w / 2, y: rect.y, dx: 0, dy: 1, length: rect.h / 2 },
      { name: "bottom", x: rect.x + rect.w / 2, y: rect.y + rect.h, dx: 0, dy: -1, length: rect.h / 2 },
      { name: "left", x: rect.x, y: rect.y + rect.h / 2, dx: 1, dy: 0, length: rect.w / 2 },
      { name: "right", x: rect.x + rect.w, y: rect.y + rect.h / 2, dx: -1, dy: 0, length: rect.w / 2 },
    ];
    for (const side of sides) {
      let [same, last] = [0, "passed"];
      for (let d = -16; d < side.length && same < 12; d += 1) {
        const [x, y] = [side.x + side.dx * (d + 0.5), side.y + side.dy * (d + 0.5)];
        const target = await at(x, y, d === -16);
        let key = ""; // no target: a point in no card, or a target that the drag cannot enter.
        if (target?.zone === "centre") break;
        if (target && target.zone !== side.name) key = "passed";
        else if (target) {
          key = keyOf(target);
          if (!slid.has(key)) {
            slid.add(key);
            await slide(x, y, side.dy * side.dy, side.dx * side.dx);
          }
        }
        if (d >= 0 && key !== "passed" && key === last) same += 1;
        else [same, last] = [0, key];
      }
    }
    if (groups.includes(id)) continue;
    await at(rect.x + rect.w / 2, rect.y + rect.h / 2, true);
    if (!source.group) {
      await at(rect.x + 1, rect.y + strip / 2, true);
      for (let x = rect.x + 1; x < rect.x + rect.w; x += 4) await at(x, rect.y + strip / 2, false);
    }
  }
  pointer(element, "pointermove", -100, -100);
  pointer(element, "pointerup", -100, -100);
  return reached;
}

// I4 of docs/spec/groups.md#invariants on the page, by the sources, the drag paths and the required targets of the Go check
// packages/workbench-mygo/tests/group_drop_invariants_test.go: over each generated layout, for the first group card, the first tab that
// is the only tab of its card and the first tab that shares its card, each required target is selected by the drag, or its result equals
// the result of a target that the drag selects, the results compared as the stored layouts after the command of the release; a target
// whose command is refused has no result and is not required.
const KINDS = { group: (s) => s.group, alone: (s) => !s.group && s.alone, shared: (s) => !s.group && !s.alone };
for (const { seed, refused, kept, sources } of layouts) {
  for (const [kind, matches] of Object.entries(KINDS)) {
    const source = sources.find(matches);
    test(`over the generated layout of seed ${seed}, every required target of the drag of the first ${kind} source is reachable`, { timeout: 120000 }, async () => {
      assert.ok(source, `the generated layout of seed ${seed} has no ${kind} source`);
      plane.adopt(structuredClone(kept), "spc-aaaaaa");
      const current = await result();
      const root = (await status("core.layout")).state.root;
      const reached = await reachedTargets(source);
      const results = new Map();
      const resultOf = async (target) => {
        const key = keyOf(target);
        if (!results.has(key)) {
          plane.adopt(structuredClone(kept), "spc-aaaaaa");
          try {
            if (source.group) await run("core.card.move", { card: source.id, target: target.card, side: target.zone });
            else await run("core.tab.move", { tab: source.id, ...target });
            results.set(key, await result());
          } catch {
            results.set(key, ""); // silent: a refused target has no result and is not required.
          }
        }
        return results.get(key);
      };
      const failures = [];
      let required = 0;
      for (const target of requiredTargets(root, source)) {
        if (reached.has(keyOf(target))) {
          required += 1;
          continue;
        }
        const want = await resultOf(target);
        if (want === "") continue;
        required += 1;
        // The reached targets of the same zone are compared first, because a merged band is mostly a node of the same side.
        const order = [...reached.values()].sort((a, b) => (a.zone !== target.zone) - (b.zone !== target.zone));
        let found = false;
        for (const other of order) if (await resultOf(other) === want) { found = true; break; }
        if (!found) failures.push(`I4 ${source.id}: no anchor and point select ${keyOf(target)} or a target of its result ${want}; the layout is ${current}`);
      }
      plane.adopt(structuredClone(kept), "spc-aaaaaa");
      assert.ok(required > 0, "no target was required");
      assert.deepEqual(failures, [], `${failures.length} failures over ${required} required targets (${refused} generated steps refused)`);
    });
  }
}
