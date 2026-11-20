// I3, I5, I6 and I9 of docs/spec/groups.md#invariants on the page workbench, over layouts that a seeded generator makes from the plane of
// arrange(). The layouts are made once, before the tests run, so this file holds no other test: the generation leaves the state of the
// page modules, which a test of another file does not share.
import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
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

