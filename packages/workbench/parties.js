// Parties of the window: groups of touching content cards with one outer outline, an optional leader and the colors
// (docs/spec/parties.md). The commands core.party.* and core.card.get, and the status core.parties, are registered by
// installParties; the rules are applied to the layout of the window that currently shows the grid.
import { outline, touches } from "soksak";
import { CHROME } from "./chrome-metrics.js";
import { windowSidebar } from "./window-sidebars.js";

/** The theme tokens of the default colors of a party, in their order (docs/spec/parties.md#commands). */
const PARTY_TOKENS = ["party-1", "party-2", "party-3", "party-4", "party-5", "party-6"];
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
// default: a window with no grid shows no cards, so the party status holds no member (docs/spec/parties.md#queries).
const spaceOrder = () => (currentGrid()?.toJSON().cards ?? []).map((card) => card.id);

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

// default: a card that no party holds reports a null party (docs/spec/parties.md#queries).
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

/** The palette of the theme and mode that the window shows; set by installParties (docs/spec/parties.md#drawing). */
let shownPalette = () => null;

/** The first default color that no party uses, or the first one when all are used. */
function defaultColor() {
  const used = new Set(parties.map((party) => party.color));
  const colors = PARTY_TOKENS.map((token) => shownPalette()[token]);
  // default: when all six party colors are used, the first one is taken (docs/spec/parties.md#identity-and-values).
  return colors.find((color) => !used.has(color)) ?? colors[0];
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
  // default: the group that the split keeps is the largest, and the first card breaks a tie (docs/spec/parties.md#changes-of-the-layout).
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
  // default: a party with no recorded member before the change removes no card (docs/spec/parties.md#changes-of-the-layout).
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
  // default: a card with no tab data has no tabs (docs/spec/parties.md#queries).
  const tabs = (cell.data?.tabs ?? []).map((tab) => ({ tab: tab.id, plugin: tab.plugin, status: {} }));
  // default: a card with no tab data reports no active tab, and a card in no party reports a null party (docs/spec/parties.md#queries).
  return { card, party: party?.id ?? null, leader: party?.leader === card, activeTab: cell.data?.activeId ?? null, tabs };
}

/**
 * The touching cards that a card in no party can group with: the cards in no party that are not window sidebars (docs/spec/parties.md#card-menu).
 * A card in a party has no candidates.
 */
export function groupCandidates(card) {
  if (partyOf(card)) return [];
  return currentGrid().toJSON().cards.map((c) => c.id)
    .filter((other) => other !== card && !partyOf(other) && !windowSidebar(other) && touches(cellOf(card), cellOf(other)));
}

/**
 * The card menu items of a content card that are party items (docs/spec/parties.md#card-menu). Each item names its element and the command
 * it runs with its params. A card in a party gets the leader item, one color item per theme token party-1 to party-6, and a take item per
 * other party that touches the card. The group item is the chooser of groupCandidates, which the card tools menu opens.
 */
export function partyMenuItems(card) {
  const cell = cellOf(card);
  const party = partyOf(card);
  const items = [];
  if (party) {
    items.push(party.leader === card
      ? { element: "core.party.menu.leader", label: "대표 카드 해제", command: "core.party.update", params: { party: party.id, leader: null } }
      : { element: "core.party.menu.leader", label: "대표 카드로 지정", command: "core.party.update", params: { party: party.id, leader: card } });
    for (const token of PARTY_TOKENS) {
      items.push({ element: "core.party.menu.color", label: `색 ${token.slice("party-".length)}`, command: "core.party.update", params: { party: party.id, color: shownPalette()[token] } });
    }
  }
  // A take removes the card from its holder, so a card in no party has no take item (docs/spec/parties.md#card-menu).
  for (const other of party ? parties : []) {
    if (other === party || !other.cards.some((member) => touches(cell, cellOf(member)))) continue;
    // A take that leaves its former party with fewer than 2 cards deletes that party, and the label states it (docs/spec/parties.md#card-menu).
    const note = party.cards.length === 2 ? `, 파티 ${party.id}가 사라짐` : "";
    items.push({ element: "core.party.menu.take", label: `파티 ${other.id}에 합치기${note}`, command: "core.party.add", params: { party: other.id, card, take: true } });
  }
  return items;
}

/**
 * The rectilinear loops of the outline of rects (docs/spec/parties.md#drawing). Adjacent cards join at half the gap of the grid, and the
 * outline is inset by half the border width. A card with no neighbour has the same outline alone.
 */
function partyLoops(grid, rects) {
  return outline(rects, { pad: grid.gap / 2, inset: BORDER / 2 }).loops.map((loop) => loop.map((point) => [point.x, point.y]));
}

/** The party record of core.parties and core.party.get, with its outline in window points. */
function record(party) {
  const rects = party.cards.map((card) => currentGrid().rect(card)).filter(Boolean);
  return {
    id: party.id, cards: [...party.cards], leader: party.leader, color: party.color, leaderColor: party.leaderColor,
    outline: partyLoops(currentGrid(), rects), reason: party.reason,
  };
}

/** The parties of the window in the form of the storage member of a space (docs/spec/parties.md#storage). */
export function storedParties() {
  return parties.map(({ id, cards, leader, color, leaderColor }) => ({ id, cards: [...cards], leader, color, leaderColor }));
}

/**
 * Replaces the parties of the window with the parties of the shown space (docs/spec/parties.md#storage). A loaded party changes no
 * composition, so its reason is null.
 */
export function loadParties(stored) {
  parties = stored.map(({ id, cards, leader, color, leaderColor }) => ({ id, cards: [...cards], leader, color, leaderColor, reason: null }));
  notify();
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
    // default: a create without a leader, a color or a leader color takes the rules of docs/spec/parties.md#identity-and-values: no leader, the first unused color and a leader color that follows the theme.
    id: nextId(), cards: inSpaceOrder(cards), leader: leader ?? null, color: color ?? defaultColor(),
    // default: the leader color that the person did not choose follows party-leader of the theme (docs/spec/parties.md#identity-and-values).
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
  return { party: { id: party.id }, changed: [row] };
}

/** Brings the parties in line with the cards of the grid after a layout change, and returns the change rows. */
/** Settles the parties after a card closed. The card leaves its party with the reason closed, and the watchers of core.parties are told. */
export function cardsClosed() {
  const rows = reconcile();
  drawParties();
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

// The border width of a party is the rail width of the theme (docs/spec/parties.md#drawing). The outline is inset by half of it.
const BORDER = parseFloat(CHROME["theme-rail-w"]);
const SVG_NS = "http://www.w3.org/2000/svg";
// The layer that holds the party paths. It is created in the plane on the first drawing.
let layer = null;
// The plane element of the page, or null when the window has no page (a test of the registry has none).
let planeOf = () => null;

function drawnPath(attributes) {
  const element = document.createElementNS(SVG_NS, "path");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

/**
 * Draws the outer outline of each party and the leader border of its leader into the plane (docs/spec/parties.md#drawing). The
 * outline is built from the presented rectangles of the cards, and the leader border is the outline of the leader card.
 */
export function drawParties() {
  const grid = currentGrid();
  const planeElement = planeOf();
  if (!grid || !planeElement) return;
  if (!layer || !layer.isConnected) {
    layer = document.createElementNS(SVG_NS, "svg");
    layer.setAttribute("class", "parties");
    layer.setAttribute("style", "position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none");
    planeElement.append(layer);
  }
  layer.replaceChildren();
  for (const party of parties) {
    const rects = party.cards.map((card) => grid.rect(card)).filter(Boolean);
    const loops = partyLoops(grid, rects);
    layer.append(drawnPath({ "data-party": party.id, d: loopsPath(loops), fill: "none", stroke: party.color, "stroke-width": BORDER }));
    if (party.leader) {
      const leaderLoops = partyLoops(grid, [grid.rect(party.leader)]);
      // default: a party with no leader color draws its leader border in the theme token party-leader (docs/spec/parties.md#drawing).
      layer.append(drawnPath({ "data-party-leader": party.id, d: sidesPath(leaderBorder(loops, leaderLoops)), fill: "none", stroke: party.leaderColor ?? shownPalette()["party-leader"], "stroke-width": BORDER }));
    }
  }
}

/** The path of closed loops of points. */
function loopsPath(loops) {
  return loops.map((loop) => `${loop.map((point, index) => `${index === 0 ? "M" : "L"}${point[0]} ${point[1]}`).join(" ")} Z`).join(" ");
}

/** The path of separate sides, each a move and a line. */
function sidesPath(sides) {
  return sides.map((side) => `M${side[0][0]} ${side[0][1]} L${side[1][0]} ${side[1][1]}`).join(" ");
}

/** The sides of the loops, each side from a point to the next point of its loop. */
function loopSides(loops) {
  return loops.flatMap((loop) => loop.map((point, index) => [point, loop[(index + 1) % loop.length]]));
}

/**
 * The parts of the outline loops that lie on the border of the leader card (docs/spec/parties.md#drawing): a side of the party outline
 * that is on a side of the leader card's own loop, with the overlap of the two sides.
 */
function leaderBorder(loops, leaderLoops) {
  const borders = loopSides(leaderLoops);
  const out = [];
  for (const side of loopSides(loops)) {
    for (const border of borders) {
      const shared = sharedPart(side, border);
      if (shared) out.push(shared);
    }
  }
  return out;
}

/** The overlap of two axis-aligned sides on the same line, or null. */
function sharedPart(a, b) {
  const horizontal = a[0][1] === a[1][1] && b[0][1] === b[1][1] && a[0][1] === b[0][1];
  const vertical = a[0][0] === a[1][0] && b[0][0] === b[1][0] && a[0][0] === b[0][0];
  if (!horizontal && !vertical) return null;
  // The coordinate along the side: x for a horizontal side, y for a vertical one.
  const along = horizontal ? 0 : 1;
  const lo = Math.max(Math.min(a[0][along], a[1][along]), Math.min(b[0][along], b[1][along]));
  const hi = Math.min(Math.max(a[0][along], a[1][along]), Math.max(b[0][along], b[1][along]));
  if (!(lo < hi)) return null;
  const line = horizontal ? a[0][1] : a[0][0];
  return horizontal ? [[lo, line], [hi, line]] : [[line, lo], [line, hi]];
}

/**
 * Registers the party commands and the party status of the window. notifyChange is called after each change so the watchers of
 * core.parties read the new value. status is the registration function of the core exposure and registry is the core registry, whose
 * command registers each party command under its declared name (the exposure check reads the name at that call).
 */
export function installParties({ status, registry, notifyChange, grid, plane, palette }) {
  notify = notifyChange;
  currentGrid = grid;
  shownPalette = palette;
  // default: a registry without a page passes no plane, so nothing is drawn.
  planeOf = plane ?? (() => null);
  status("core.parties", () => (currentGrid() ? partyList() : []));
  const run = (fn) => (params) => {
    const result = fn(params);
    drawParties();
    notify();
    return result;
  };
  registry.command("core.party.create", run(create));
  registry.command("core.party.update", run(update));
  registry.command("core.party.add", run(add));
  registry.command("core.party.remove", run(remove));
  registry.command("core.party.delete", run(deleteParty));
  registry.command("core.party.get", ({ party }) => ({ ...record(byId(party)), members: memberStates(byId(party)) }));
  registry.command("core.card.get", ({ card }) => {
    if (!cellOf(card)) fail(`unknown card ${card}`);
    return cardState(card);
  });
}
