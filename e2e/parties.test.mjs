// Checks the parties of a window on each host (docs/spec/parties.md): the party commands and their replies and refusals, the watch of
// core.parties, which delivers a value for each change of the composition and none for other work, the queries core.party.get and
// core.card.get, the outline of a party against the rail, and the parties that a save and a reload keep in projects.json.
//
// The drawn paths of a page workbench (path[data-party], path[data-party-leader] and #railPath) are no declared entry, so the drawing is
// judged by the loops that the drawing is built from: `outline` of core.parties and the loops of the rail groups of core.rail. Both are
// built from the card rectangles of core.grid in the coordinates of the plane, on every host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import workbench from "@soksak/workbench/workbench.json" with { type: "json" };
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { projectRecords } from "./projects-file.mjs";

/** The border width of a party, which is the rail width of the theme (docs/spec/parties.md#rules). */
const RAIL_WIDTH = parseFloat(workbench.chrome["theme-rail-w"]);
const HEX = /^#[0-9a-f]{6}$/i;
// A difference of coordinates below this is the same coordinate: the outline and the rail are computed in floating point.
const SAME = 0.01;

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const cardOfTab = (grid, tab) => grid.cards.find((card) => card.tabs?.some((item) => item.id === tab));
const record = ({ id, cards, leader, color, leaderColor }) => ({ id, cards, leader, color, leaderColor });

/**
 * Prepares four content cards in the middle column of the start layout and returns their identifiers: `top` and `topRight` side by
 * side in the top row, `bottom` below both of them and `lowest` below `bottom`. `top` and `lowest` touch no common side, and the window
 * sidebar `right` stands at the right of `topRight`, `bottom` and `lowest`. The cleanup deletes the parties that remain and closes the
 * cards that the preparation made, so no party and no card is left for the next check.
 */
async function partyCards(s) {
  const { surface, plugin } = await fresh(s);
  const start = await s.get("core.grid");
  assert.deepEqual(await s.get("core.parties"), [], "the start layout of the check holds parties");
  assert.ok(start.cards.some((card) => card.id === "right" && card.fixed), `the start layout has no window sidebar right: ${JSON.stringify(start.cards.map((card) => card.id))}`);
  const content = start.cards.filter((card) => !card.fixed);
  assert.equal(content.length, 2, `the start layout holds ${content.length} content cards, expected 2`);
  const [top, bottom] = [...content].sort((a, b) => a.y - b.y).map((card) => card.id);
  const made = [];
  s.cleanupSteps(
    async () => {
      for (const party of await s.get("core.parties")) await s.run("core.party.delete", { party: party.id });
    },
    async () => {
      for (const card of [...made].reverse()) await s.run("core.card.close", { card });
      await s.presented();
    },
  );
  const split = async (card, side) => {
    const { tab } = await s.run("core.card.split", { card, side, plugin });
    const born = cardOfTab(await s.get("core.grid"), tab);
    assert.ok(born, `the split of ${card} toward ${side} made no card that holds ${tab}`);
    made.push(born.id);
    return born.id;
  };
  const topRight = await split(top, "right");
  const lowest = await split(bottom, "bottom");
  await s.presented();
  return { surface, plugin, top, topRight, bottom, lowest };
}

/** Runs a party command that the contract refuses and requires the refusal text of docs/spec/parties.md#commands. */
async function refused(s, name, params, text) {
  await assert.rejects(s.run(name, params), (error) => {
    assert.ok(error.message.includes(text), `${name} ${JSON.stringify(params)}: expected the refusal "${text}", found "${error.message}"`);
    return true;
  });
}

/** The points of a loop as `[x, y]` pairs: core.parties holds pairs and the rail groups hold `{x, y}` points. */
const pointsOf = (loop) => loop.map((point) => (Array.isArray(point) ? point : [point.x, point.y]));

/** The axis-aligned sides of closed loops, each `{vertical, at, from, to}`; a side of the rounded corners of the rail is no axis side. */
function sidesOf(loops) {
  const sides = [];
  for (const loop of loops) {
    const points = pointsOf(loop);
    for (let index = 0; index < points.length; index += 1) {
      const [a, b] = [points[index], points[(index + 1) % points.length]];
      if (Math.abs(a[0] - b[0]) < SAME && Math.abs(a[1] - b[1]) >= SAME) sides.push({ vertical: true, at: a[0], from: Math.min(a[1], b[1]), to: Math.max(a[1], b[1]) });
      else if (Math.abs(a[1] - b[1]) < SAME && Math.abs(a[0] - b[0]) >= SAME) sides.push({ vertical: false, at: a[1], from: Math.min(a[0], b[0]), to: Math.max(a[0], b[0]) });
    }
  }
  return sides;
}

const overlap = (a, b) => Math.min(a.to, b.to) - Math.max(a.from, b.from);

/** The bounds of the points of loops, `{x0, y0, x1, y1}`. */
function boundsOf(loops) {
  const points = loops.flatMap(pointsOf);
  return {
    x0: Math.min(...points.map((point) => point[0])), y0: Math.min(...points.map((point) => point[1])),
    x1: Math.max(...points.map((point) => point[0])), y1: Math.max(...points.map((point) => point[1])),
  };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: party commands reply, refuse and take by the contract`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { top, topRight, bottom, lowest } = await partyCards(s);

    // Each refusal of the table in its order; a refused command changes nothing.
    await refused(s, "core.party.create", { cards: [top, "missing-card"] }, "unknown card missing-card");
    await refused(s, "core.party.create", { cards: ["right", top] }, "card right is a window sidebar");
    await refused(s, "core.party.create", { cards: [top, top] }, `card ${top} is listed more than once`);
    await refused(s, "core.party.create", { cards: [top] }, "a party needs at least 2 cards");
    await refused(s, "core.party.create", { cards: [top, lowest] }, `cards are not touching: ${lowest}`);
    await refused(s, "core.party.create", { cards: [top, topRight], leader: bottom }, `leader ${bottom} is not in the party`);
    await refused(s, "core.party.create", { cards: [top, topRight], color: "red" }, "color must be #rrggbb");
    await refused(s, "core.party.update", { party: "p9", color: "#123456" }, "unknown party p9");
    await refused(s, "core.party.get", { party: "p9" }, "unknown party p9");
    assert.deepEqual(await s.get("core.parties"), [], "a refused command changed the parties");

    // create makes p1 with its leader and the first free party color.
    const created = await s.run("core.party.create", { cards: [top, topRight], leader: top });
    assert.deepEqual({ ...record(created.party), color: undefined, reason: created.party.reason },
      { id: "p1", cards: [top, topRight], leader: top, color: undefined, leaderColor: null, reason: "created" });
    assert.match(created.party.color, HEX, `the party color ${created.party.color} is not #rrggbb`);
    assert.deepEqual(created.taken, []);
    assert.deepEqual(created.changed, [{ party: "p1", removed: [], leader: top, deleted: false }]);

    // The same card set again returns the same party and changes nothing.
    const again = await s.run("core.party.create", { cards: [top, topRight], leader: top });
    assert.equal(again.party.id, "p1");
    assert.deepEqual(again.changed, [], "a repeated create changed a party");
    assert.equal((await s.get("core.parties")).length, 1, "a repeated create made another party");

    // A second party that touches the first takes another default color.
    const second = await s.run("core.party.create", { cards: [bottom, lowest] });
    assert.deepEqual(record(second.party), { id: "p2", cards: [bottom, lowest], leader: null, color: second.party.color, leaderColor: null });
    assert.match(second.party.color, HEX);
    assert.notEqual(second.party.color, created.party.color, "two touching parties took the same default color");

    // Refusals that need a party.
    await refused(s, "core.party.create", { cards: [topRight, bottom] }, `card ${topRight} belongs to party p1`);
    await refused(s, "core.party.update", { party: "p1", color: "red" }, "color must be #rrggbb");
    await refused(s, "core.party.update", { party: "p1", leaderColor: "blue" }, "leaderColor must be #rrggbb or null");
    await refused(s, "core.party.update", { party: "p1", leader: bottom }, `leader ${bottom} is not in the party`);
    await refused(s, "core.party.add", { party: "p2", card: topRight }, `card ${topRight} belongs to party p1`);
    await refused(s, "core.party.remove", { party: "p2", card: top }, `card ${top} is not in party p2`);
    const kept = await s.get("core.parties");
    assert.deepEqual(kept.map(record), [record(created.party), record(second.party)], "a refused command changed the parties");

    // update sets the leader color and removes the leader.
    const colored = await s.run("core.party.update", { party: "p1", leaderColor: "#ff0000" });
    assert.deepEqual({ ...record(colored.party), reason: colored.party.reason },
      { id: "p1", cards: [top, topRight], leader: top, color: created.party.color, leaderColor: "#ff0000", reason: "updated" });
    assert.deepEqual(colored.changed, [{ party: "p1", removed: [], leader: top, deleted: false }]);
    const leaderless = await s.run("core.party.update", { party: "p1", leader: null });
    assert.equal(leaderless.party.leader, null);
    assert.deepEqual(leaderless.changed, [{ party: "p1", removed: [], leader: null, deleted: false }]);

    // add of a member changes nothing.
    const member = await s.run("core.party.add", { party: "p1", card: top });
    assert.deepEqual([member.party.cards, member.taken, member.changed], [[top, topRight], [], []]);

    // take moves topRight into p2; p1 keeps one card, so it is deleted and lists every card it had.
    const taken = await s.run("core.party.add", { party: "p2", card: topRight, take: true });
    assert.deepEqual(record(taken.party), { id: "p2", cards: [bottom, lowest, topRight], leader: null, color: second.party.color, leaderColor: null });
    assert.deepEqual(taken.taken, [{ card: topRight, from: "p1" }]);
    assert.deepEqual(taken.changed, [
      { party: "p1", removed: [top, topRight], leader: null, deleted: true },
      { party: "p2", removed: [], leader: null, deleted: false },
    ]);
    await refused(s, "core.party.get", { party: "p1" }, "unknown party p1");

    // remove keeps the rest, which touches as one group.
    const removed = await s.run("core.party.remove", { party: "p2", card: lowest });
    assert.deepEqual(removed.party.cards, [bottom, topRight]);
    assert.deepEqual(removed.changed, [{ party: "p2", removed: [lowest], leader: null, deleted: false }]);
    const added = await s.run("core.party.add", { party: "p2", card: top });
    assert.deepEqual([added.party.cards, added.taken, added.changed],
      [[bottom, topRight, top], [], [{ party: "p2", removed: [], leader: null, deleted: false }]]);

    // delete keeps the cards in the layout.
    const deleted = await s.run("core.party.delete", { party: "p2" });
    assert.deepEqual(deleted, { party: { id: "p2" }, changed: [{ party: "p2", removed: [bottom, topRight, top], leader: null, deleted: true }] });
    assert.deepEqual(await s.get("core.parties"), []);
    const cards = (await s.get("core.grid")).cards.map((card) => card.id);
    for (const card of [top, topRight, bottom, lowest]) assert.ok(cards.includes(card), `the delete of p2 removed the card ${card}`);
  });

  test(`${app.name}: core.parties changes with the composition only and the queries share the card state`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface, top, topRight, bottom, lowest } = await partyCards(s);
    const watch = await s.collect("core.parties");
    let watching = true;
    s.cleanup(async () => {
      if (watching) await watch.stop();
    });
    assert.deepEqual(watch.values, [[]], "the watch of core.parties did not start with an empty list");

    // A composition change delivers one new value before the reply of its command (docs/spec/parties.md#host-calls).
    const created = await s.run("core.party.create", { cards: [top, bottom], leader: bottom });
    assert.equal(watch.values.length, 2, `the create delivered ${watch.values.length - 1} values of core.parties, expected 1`);
    assert.deepEqual(watch.values[1].map(record), [record(created.party)]);

    // Work that changes no composition delivers no value: a focus of a card outside the party and a title of a member tab.
    await s.run("core.card.focus", { card: lowest });
    await s.presented();
    const title = "party watch";
    s.cleanup(() => s.run("layoutprobe.title", { text: null }, surface));
    await s.run("layoutprobe.title", { text: title }, surface);
    await s.until("core.grid", (grid) => grid.cards.flatMap((card) => card.tabs ?? []).find((tab) => tab.id === surface)?.label === title,
      "the member tab did not show its title");
    // The color change delivers its value before its reply, so a value of the work before it is in the list before that value.
    await s.run("core.party.update", { party: "p1", color: "#123456" });
    watching = false;
    const values = await watch.stop();
    assert.equal(values.length, 3, `core.parties delivered ${values.length} values, expected 3: ${JSON.stringify(values.map((value) => value.map(record)))}`);
    assert.equal(values[2][0].color, "#123456");

    // core.party.get: the record of core.parties and the card state of each member, the leader first and the others in space order.
    const party = await s.run("core.party.get", { party: "p1" });
    const listed = (await s.get("core.parties"))[0];
    const { members, ...fields } = party;
    assert.deepEqual(fields, listed, "core.party.get and core.parties differ in the record of p1");
    assert.deepEqual(Object.keys(fields).sort(), ["cards", "color", "id", "leader", "leaderColor", "outline", "reason"]);
    const grid = await s.get("core.grid");
    const order = grid.cards.map((card) => card.id).filter((card) => party.cards.includes(card) && card !== bottom);
    assert.deepEqual(members.map((state) => state.card), [bottom, ...order], "the members are not the leader first and then the space order");

    // core.card.get gives the same card state as the members, for a card in a party and for a card in none.
    for (const state of members) assert.deepEqual(await s.run("core.card.get", { card: state.card }), state, `core.card.get ${state.card} differs from its member state`);
    for (const card of [top, bottom, topRight, lowest]) {
      const state = await s.run("core.card.get", { card });
      const shown = grid.cards.find((item) => item.id === card);
      const inParty = card === top || card === bottom;
      assert.deepEqual(state, {
        card, party: inParty ? "p1" : null, leader: card === bottom, activeTab: shown.active,
        // The layout probe declares no status with summary, so each of its tabs has an empty status.
        tabs: shown.tabs.map((tab) => ({ tab: tab.id, plugin: tab.plugin, status: {} })),
      }, `the card state of ${card}`);
    }
    await refused(s, "core.card.get", { card: "missing-card" }, "unknown card missing-card");
  });

  test(`${app.name}: a party outline joins its cards and stays inside the rail by the rail width`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { plugin, top, bottom, lowest } = await partyCards(s);
    // The right override of the layout probe ties the window sidebar right to the focused card, so the rail outlines that card with
    // the sidebar (docs/spec/external-sidebars.md#override-context-and-rail-border).
    await keepCommonSettings(s);
    const sets = (await s.get("core.settings")).values.sets;
    const set = { id: "check-party-rail", title: "Rail", sections: ["layoutprobe.alpha", "layoutprobe.fill"], layout: "list" };
    await s.run("core.settings.set", { patch: { sets: [...sets, set] }, scope: "common" });
    await s.run("core.settings.link", { place: "window-right", plugin, set: set.id, scope: "common" });

    await s.run("core.party.create", { cards: [bottom, lowest], leader: bottom });
    // With the focus outside the party, the outline is the bounds of its cards padded by half the gap and inset by half the border.
    await s.run("core.card.focus", { card: top });
    await s.presented();
    const grid = await s.get("core.grid");
    const [party] = await s.get("core.parties");
    assert.equal(party.outline.length, 1, `the party of two touching cards has ${party.outline.length} loops, expected 1`);
    const rects = party.cards.map((card) => grid.cards.find((item) => item.id === card));
    const offset = grid.gap / 2 - RAIL_WIDTH / 2;
    const expected = {
      x0: Math.min(...rects.map((r) => r.x)) - offset, y0: Math.min(...rects.map((r) => r.y)) - offset,
      x1: Math.max(...rects.map((r) => r.x + r.w)) + offset, y1: Math.max(...rects.map((r) => r.y + r.h)) + offset,
    };
    const bounds = boundsOf(party.outline);
    for (const key of Object.keys(expected)) {
      assert.ok(Math.abs(bounds[key] - expected[key]) < SAME, `the outline bound ${key} is ${bounds[key]}, expected ${expected[key]}: outline ${JSON.stringify(party.outline)}, cards ${JSON.stringify(rects)}, gap ${grid.gap}`);
    }

    // With the focus on the leader, the rail outlines the leader and the sidebar: each side of the party outline on a side of the
    // leader that the rail also outlines lies the rail width inside the rail, and no side of the two lines coincides.
    await s.run("core.card.focus", { card: bottom });
    await s.presented();
    const rail = await s.get("core.rail");
    const group = rail.groups.find((item) => item.card === bottom);
    assert.ok(group, `the rail has no group of the focused card ${bottom}: ${JSON.stringify(rail.groups.map((item) => item.card))}`);
    const [drawn] = await s.get("core.parties");
    const railSides = sidesOf(rail.groups.flatMap((item) => item.loops));
    const partySides = sidesOf(drawn.outline);
    const coinciding = partySides.filter((side) => railSides.some((other) => other.vertical === side.vertical
      && Math.abs(other.at - side.at) < SAME && overlap(side, other) >= SAME));
    assert.deepEqual(coinciding, [], `sides of the party outline coincide with the rail: rail ${rail.path}, party ${JSON.stringify(drawn.outline)}`);
    const card = (await s.get("core.grid")).cards.find((item) => item.id === bottom);
    const edges = [
      { vertical: true, at: card.x, inward: 1, from: card.y, to: card.y + card.h },
      { vertical: true, at: card.x + card.w, inward: -1, from: card.y, to: card.y + card.h },
      { vertical: false, at: card.y, inward: 1, from: card.x, to: card.x + card.w },
      { vertical: false, at: card.y + card.h, inward: -1, from: card.x, to: card.x + card.w },
    ];
    const near = (side, edge) => side.vertical === edge.vertical && Math.abs(side.at - edge.at) <= grid.gap / 2 + SAME && overlap(side, edge) >= SAME;
    const close = [];
    let compared = 0;
    for (const edge of edges) {
      for (const outer of railSides.filter((side) => near(side, edge))) {
        for (const inner of partySides.filter((side) => near(side, edge) && overlap(side, outer) >= SAME)) {
          compared += 1;
          if ((inner.at - outer.at) * edge.inward < RAIL_WIDTH - SAME) close.push({ edge, rail: outer, party: inner });
        }
      }
    }
    assert.ok(compared > 0, `no side of the party outline lies on a side of ${bottom} that the rail outlines: rail ${JSON.stringify(railSides)}, party ${JSON.stringify(partySides)}`);
    assert.deepEqual(close, [], `the party outline is not the rail width ${RAIL_WIDTH} inside the rail`);
  });

  test(`${app.name}: a save and a reload keep the parties of the space`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { top, topRight } = await partyCards(s);
    await s.run("core.party.create", { cards: [top, topRight], leader: top, leaderColor: "#00ff00" });
    await s.run("core.party.update", { party: "p1", color: "#a1b2c3" });
    const stored = { id: "p1", cards: [top, topRight], leader: top, color: "#a1b2c3", leaderColor: "#00ff00" };
    await s.run("core.projects.flush");

    // The space object holds the member parties with the stored fields only; reason and outline are derived (docs/spec/parties.md#storage).
    const project = await s.get("core.project");
    const file = join(s.app.configDir, "projects.json");
    const saved = projectRecords(read(file), file).find((item) => item.id === project.id);
    assert.ok(saved, `${file} holds no project ${project.id}`);
    const space = saved.spaces.find((item) => item.id === saved.activeSpaceId);
    assert.deepEqual(space.parties, [stored], `the saved space ${space.id} holds parties ${JSON.stringify(space.parties)}`);

    const before = (await s.get("core.window.workbench")).start;
    await s.run("host.window.reload");
    await s.until("core.window.workbench", (value) => value.start !== before && value.readyState === "complete",
      "the workbench did not start again");
    const [party, ...others] = await s.until("core.parties", (value) => value.length > 0, "the reloaded workbench reported no party");
    assert.deepEqual([record(party), others], [stored, []], "the reloaded workbench changed the parties of the space");
  });
}
