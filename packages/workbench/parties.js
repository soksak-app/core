// Parties of the window: groups of touching content cards with one outer outline, an optional leader and the colors
// (docs/spec/parties.md). The commands core.party.* and core.card.get, and the status core.parties, are registered by
// installParties; the rules are applied to the layout of the window that currently shows the grid.
import { outline } from "soksak";
import { windowSidebar } from "./window-sidebars.js";

/** The default colors of a party, the theme tokens party-1 to party-6 of the current theme, in their order. */
const PARTY_COLORS = ["#5b8def", "#e0834b", "#4fb07a", "#c05ad0", "#d9b13a", "#3fb5c4"];
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The parties of the window, in creation order. */
let parties = [];

/** Notifies the watchers of core.parties after a change; set by installParties. */
let notify = () => {};

const fail = (text) => {
  throw new Error(text);
};

/** The grid of the window that shows the layout, or null. It is read through installParties, so this module imports no page module. */
let currentGrid = () => null;

/** The cell rectangle of a card in the grid, or undefined. */
const cellOf = (id) => currentGrid()?.card(id);

/** The card ids of the grid in space order. */
const spaceOrder = () => (currentGrid()?.toJSON().cards ?? []).map((card) => card.id);

/** Whether two cards touch: their sides meet across the gap of the grid, with the other axis overlapping. */
function touches(a, b) {
  const overlapRows = a.r0 < b.r1 && b.r0 < a.r1;
  const overlapCols = a.c0 < b.c1 && b.c0 < a.c1;
  return (overlapRows && (a.c1 === b.c0 || b.c1 === a.c0)) || (overlapCols && (a.r1 === b.r0 || b.r1 === a.r0));
}

/** Splits card ids into connected groups of touching cards; each group keeps the order of ids. */
function groupsOf(ids) {
  const left = [...ids];
  const groups = [];
  while (left.length) {
    const group = [left.shift()];
    for (let grown = true; grown;) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        if (group.some((member) => touches(cellOf(member), cellOf(left[i])))) {
          group.push(left.splice(i, 1)[0]);
          grown = true;
          i--;
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

const partyOf = (card) => parties.find((party) => party.cards.includes(card)) ?? null;

const byId = (id) => {
  const party = parties.find((candidate) => candidate.id === id);
  if (!party) fail(`unknown party ${id}`);
  return party;
};

/** The smallest p<n> that no party holds. */
function nextId() {
  for (let n = 1; ; n++) if (!parties.some((party) => party.id === `p${n}`)) return `p${n}`;
}

/** The first default color that no party uses, or the first one when all are used. */
function defaultColor() {
  const used = new Set(parties.map((party) => party.color));
  return PARTY_COLORS.find((color) => !used.has(color)) ?? PARTY_COLORS[0];
}

/** The cards of a party in space order. */
const inSpaceOrder = (cards) => spaceOrder().filter((id) => cards.includes(id));

/** Validates a card list in the order of the refusal table of the specification. */
function checkCards(cards) {
  if (!Array.isArray(cards)) fail("cards must be a list of card ids");
  for (const card of cards) if (!cellOf(card)) fail(`unknown card ${card}`);
  for (const card of cards) if (windowSidebar(card)) fail(`card ${card} is a window sidebar`);
  cards.forEach((card, index) => {
    if (cards.indexOf(card) !== index) fail(`card ${card} is listed more than once`);
  });
  if (cards.length < 2) fail("a party needs at least 2 cards");
  if (groupsOf(cards).length !== 1) fail(`cards are not touching: ${cards.join(", ")}`);
}

/**
 * Applies the split rule to the cards that remain of a party after a change (docs/spec/parties.md#changes-of-the-layout). The part
 * with the leader stays, else the part with the most cards, and equal counts keep the part whose first card comes first in the space
 * order. Returns the kept cards and the reason of the split, or null when the cards still form one group.
 */
function splitRule(party, remaining) {
  const groups = groupsOf(remaining);
  if (groups.length <= 1) return { cards: remaining, reason: null };
  const order = spaceOrder();
  const first = (group) => Math.min(...group.map((card) => order.indexOf(card)));
  const withLeader = groups.find((group) => group.includes(party.leader));
  if (withLeader) return { cards: inSpaceOrder(withLeader), reason: "split-leader" };
  const kept = [...groups].sort((a, b) => b.length - a.length || first(a) - first(b))[0];
  return { cards: inSpaceOrder(kept), reason: "split-most-cards" };
}

/**
 * Settles a party after its cards changed: a card that left the grid leaves the party, a split keeps one part, and a party with
 * fewer than 2 cards is deleted. before is the card list before the change, and the row lists the cards that left the party.
 */
function settle(party, reason, before) {
  const present = party.cards.filter((card) => cellOf(card));
  let finalReason = reason;
  if (present.length !== party.cards.length && !finalReason) finalReason = "closed";
  party.cards = present;
  if (party.leader && !present.includes(party.leader)) party.leader = null;
  if (party.cards.length >= 2) {
    const split = splitRule(party, party.cards);
    if (split.reason) {
      party.cards = split.cards;
      if (!party.cards.includes(party.leader)) party.leader = null;
      finalReason = split.reason;
    }
  }
  const deleted = party.cards.length < 2;
  party.reason = deleted ? "too-few" : finalReason;
  const removed = (before ?? []).filter((card) => !party.cards.includes(card));
  return { party: party.id, removed, leader: deleted ? null : party.leader, deleted };
}

/** Removes the parties that have fewer than 2 cards, as settle deletes them. */
function finish() {
  parties = parties.filter((party) => party.cards.length >= 2);
}

/** Members of the party as card states, the leader first and the other cards in space order. */
function memberStates(party) {
  return [party.leader, ...party.cards.filter((card) => card !== party.leader)].filter(Boolean).map(cardState);
}

/** The card state of a card (docs/spec/parties.md#queries). */
export function cardState(card) {
  const cell = cellOf(card);
  const party = partyOf(card);
  const tabs = (cell.data?.tabs ?? []).map((tab) => ({ tab: tab.id, plugin: tab.plugin, status: {} }));
  return { card, party: party?.id ?? null, leader: party?.leader === card, activeTab: cell.data?.activeId ?? null, tabs };
}

/** The party record of core.parties and core.party.get, with its outline in window points. */
function record(party) {
  const rects = party.cards.map((card) => currentGrid().rect(card)).filter(Boolean);
  return {
    id: party.id, cards: [...party.cards], leader: party.leader, color: party.color, leaderColor: party.leaderColor,
    outline: outline(rects).loops.map((loop) => loop.map((point) => [point.x, point.y])), reason: party.reason,
  };
}

/** The list of the party records, one per party (core.parties). */
export function partyList() {
  return parties.map(record);
}

/** Creates the party of a card list and returns the reply of core.party.create. */
function create({ cards, color, leader, leaderColor, take = false }) {
  checkCards(cards);
  const existing = parties.find((party) => party.cards.length === cards.length && cards.every((card) => party.cards.includes(card)));
  if (existing) return { party: record(existing), taken: [], changed: [] };
  for (const card of cards) {
    const holder = partyOf(card);
    if (holder && !take) fail(`card ${card} belongs to party ${holder.id}`);
  }
  if (leader !== undefined && leader !== null && !cards.includes(leader)) fail(`leader ${leader} is not in the party`);
  if (color !== undefined && !HEX.test(color)) fail("color must be #rrggbb");
  if (leaderColor !== undefined && leaderColor !== null && !HEX.test(leaderColor)) fail("color must be #rrggbb");
  const taken = [];
  const changed = [];
  for (const card of cards) {
    const holder = partyOf(card);
    if (!holder) continue;
    taken.push({ card, from: holder.id });
    const before = [...holder.cards];
    holder.cards = holder.cards.filter((member) => member !== card);
    if (holder.leader === card) holder.leader = null;
    changed.push(settle(holder, "taken", before));
  }
  finish();
  const party = {
    id: nextId(), cards: inSpaceOrder(cards), leader: leader ?? null, color: color ?? defaultColor(),
    leaderColor: leaderColor ?? null, reason: "created",
  };
  parties.push(party);
  changed.push({ party: party.id, removed: [], leader: party.leader, deleted: false });
  return { party: record(party), taken, changed };
}

/** Updates the color, the leader or the leader color of a party. */
function update({ party: id, color, leader, leaderColor }) {
  const party = byId(id);
  if (color !== undefined && !HEX.test(color)) fail("color must be #rrggbb");
  if (leaderColor !== undefined && leaderColor !== null && !HEX.test(leaderColor)) fail("color must be #rrggbb");
  if (leader !== undefined && leader !== null && !party.cards.includes(leader)) fail(`leader ${leader} is not in the party`);
  const before = JSON.stringify([party.leader, party.color, party.leaderColor]);
  if (leader !== undefined) party.leader = leader;
  if (color !== undefined) party.color = color;
  if (leaderColor !== undefined) party.leaderColor = leaderColor;
  const changed = JSON.stringify([party.leader, party.color, party.leaderColor]) === before
    ? [] : [{ party: party.id, removed: [], leader: party.leader, deleted: false }];
  if (changed.length) party.reason = "updated";
  return { party: record(party), changed };
}

/** Adds a card that touches the party. */
function add({ party: id, card, take = false }) {
  const party = byId(id);
  checkCards([card, ...party.cards.filter((member) => member !== card)]);
  if (party.cards.includes(card)) return { party: record(party), taken: [], changed: [] };
  const holder = partyOf(card);
  if (holder && !take) fail(`card ${card} belongs to party ${holder.id}`);
  if (!party.cards.some((member) => touches(cellOf(member), cellOf(card)))) fail(`cards are not touching: ${card}`);
  const taken = [];
  const changed = [];
  if (holder) {
    taken.push({ card, from: holder.id });
    const before = [...holder.cards];
    holder.cards = holder.cards.filter((member) => member !== card);
    if (holder.leader === card) holder.leader = null;
    changed.push(settle(holder, "taken", before));
  }
  finish();
  party.cards = inSpaceOrder([...party.cards, card]);
  party.reason = "taken";
  changed.push({ party: party.id, removed: [], leader: party.leader, deleted: false });
  return { party: record(party), taken, changed };
}

/** Removes a card from a party and applies the split rule to the rest. */
function remove({ party: id, card }) {
  const party = byId(id);
  if (!party.cards.includes(card)) return { party: record(party), changed: [] };
  const before = [...party.cards];
  party.cards = party.cards.filter((member) => member !== card);
  if (party.leader === card) party.leader = null;
  const row = settle(party, "removed", before);
  finish();
  return { party: row.deleted ? null : record(party), changed: [row] };
}

/** Deletes a party and keeps its cards in the layout. */
function deleteParty({ party: id }) {
  const party = byId(id);
  const row = { party: party.id, removed: [...party.cards], leader: null, deleted: true };
  parties = parties.filter((candidate) => candidate !== party);
  return { party: null, changed: [row] };
}

/** Brings the parties in line with the cards of the grid after a layout change, and returns the change rows. */
/** Settles the parties after a card closed. The card leaves its party with the reason closed, and the watchers of core.parties are told. */
export function cardsClosed() {
  const rows = reconcile();
  notify();
  return rows;
}

export function reconcile() {
  const rows = [];
  for (const party of parties) {
    if (party.cards.every((card) => cellOf(card))) continue;
    rows.push(settle(party, "closed", [...party.cards]));
  }
  finish();
  return rows;
}

/**
 * Registers the party commands and the party status of the window. notifyChange is called after each change so the watchers of
 * core.parties read the new value. status and command are the registration functions of the core exposure.
 */
export function installParties({ status, command, notifyChange, grid }) {
  notify = notifyChange;
  currentGrid = grid;
  status("core.parties", () => (currentGrid() ? partyList() : []));
  const run = (fn) => (params) => {
    const result = fn(params);
    notify();
    return result;
  };
  command("core.party.create", run(create));
  command("core.party.update", run(update));
  command("core.party.add", run(add));
  command("core.party.remove", run(remove));
  command("core.party.delete", run(deleteParty));
  command("core.party.get", ({ party }) => ({ ...record(byId(party)), members: memberStates(byId(party)) }));
  command("core.card.get", ({ card }) => {
    if (!cellOf(card)) fail(`unknown card ${card}`);
    return cardState(card);
  });
}
