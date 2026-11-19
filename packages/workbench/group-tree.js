// The group tree of a space (docs/spec/groups.md#model): one grid of the layout library, unchanged, and beside it a tree of group cards,
// each naming the cards whose cells form one rectangle of that grid. The tree holds the leader of each level and the card numbers that
// the space issued; it draws the headers of the group cards over the top of their rectangles, acts on the rectangle of a group card with
// the operations of the library, and refuses an operation that leaves a group card without one rectangle or draws a content card below
// its minimum (docs/spec/groups.md#minimum-size). The Go layout model of packages/workbench-mygo passes the same shared cases,
// docs/spec/cases/layout/groups.json.
import { checkState } from "soksak";
import { isPlace } from "./registry.js";

/** The sides of a split, a group and a move beside a card. */
const SIDES = ["left", "right", "top", "bottom"];

/** The difference under which two drawn sizes are the same. */
const EPSILON = 1e-6;

/** The largest lastCard that a space stores. */
const LAST_LIMIT = 2 ** 31 - 1;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A drawn size in whole points. */
const sizeText = (w, h) => `${Math.round(w)}x${Math.round(h)}`;

/** The identifier of a member: a content card id, or the id of a group node. */
const memberId = (member) => (typeof member === "string" ? member : member.card);

/** n of a card id card-<n>, or null. */
export function cardNumber(id) {
  const match = /^card-([1-9][0-9]*)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** A card of a state with the coordinates of its lines: {card, x0, x1, y0, y1}. */
const withCoordinates = (state) => state.cards.map((card) => ({
  card, x0: state.xs[card.c0], x1: state.xs[card.c1], y0: state.ys[card.r0], y1: state.ys[card.r1],
}));

/**
 * The state of the cards at their coordinates: every coordinate that a card uses is one line, equal coordinates as numbers and without a
 * tolerance (R1), and a line that no card uses is left out (tidy). paidBy keeps the entries that name no card of dropped.
 */
function fromCoordinates(placed, paidBy, dropped) {
  const lines = (lo, hi) => [...new Set(placed.flatMap((item) => [item[lo], item[hi]]))].sort((a, b) => a - b);
  const xs = lines("x0", "x1");
  const ys = lines("y0", "y1");
  const cards = placed.map(({ card, x0, x1, y0, y1 }) => ({ ...card, c0: xs.indexOf(x0), c1: xs.indexOf(x1), r0: ys.indexOf(y0), r1: ys.indexOf(y1) }));
  const paid = Object.fromEntries(Object.entries(paidBy).filter(([id, record]) => !dropped.has(id) && !dropped.has(record.to))
    .map(([id, record]) => [id, { ...record }]));
  return { xs, ys, cards, paidBy: paid };
}

/** The coordinate t of the span [a0, b0] mapped into [a, b]; the ends map to the ends exactly. */
function mapped(t, [a0, b0], [a, b]) {
  if (t === a0) return a;
  if (t === b0) return b;
  return a + (b - a) * (t - a0) / (b0 - a0);
}

/** The group tree of one space over its grid. */
export class GroupTree {
  /**
   * grid is the grid of the space; options are the gap, the smallest drawn edge of a content card (minSize) and the head height of a
   * group header (head); groups are the group nodes of the root level, leader the leader of the root level or null, last lastCard.
   */
  constructor(grid, options, groups, leader, last) {
    this.grid = grid;
    this.options = { ...options };
    this.groups = groups;
    this.rootLeader = leader;
    this.last = last;
  }

  /** Changes the gap, the smallest edge and the head height. The grid keeps its proportions (R5). */
  setOptions(options) {
    this.options = { ...options };
    this.grid.gap = options.gap;
  }

  /** The line indices {c0, c1, r0, r1} of a member: the card of the grid, or the rectangle of a group node. */
  box(member) {
    if (typeof member !== "string") return this.rectangle(member);
    const { c0, c1, r0, r1 } = this.grid.card(member);
    return { c0, c1, r0, r1 };
  }

  /** The members ordered by the first row line and then by the first column line of their boxes (docs/spec/groups.md#model). */
  readingOrder(members) {
    return [...members].sort((a, b) => {
      const p = this.box(a), q = this.box(b);
      return (p.r0 - q.r0) || (p.c0 - q.c0);
    });
  }

  /** The content cards inside a group node. */
  contents(node) {
    return node.members.flatMap((member) => (typeof member === "string" ? [member] : this.contents(member)));
  }

  /** The rectangle of a group node in line indices: the span of the content cards inside it. */
  rectangle(node) {
    const boxes = this.contents(node).map((id) => this.grid.card(id));
    return {
      c0: Math.min(...boxes.map((card) => card.c0)), c1: Math.max(...boxes.map((card) => card.c1)),
      r0: Math.min(...boxes.map((card) => card.r0)), r1: Math.max(...boxes.map((card) => card.r1)),
    };
  }

  /** Whether the content cards inside a group node hold exactly the cells of its rectangle. */
  covers(node) {
    const { c0, c1, r0, r1 } = this.rectangle(node);
    const cells = this.contents(node).reduce((n, id) => {
      const card = this.grid.card(id);
      return n + (card.c1 - card.c0) * (card.r1 - card.r0);
    }, 0);
    return cells === (c1 - c0) * (r1 - r0);
  }

  /** Every group node of the tree in workbench order. */
  nodes() {
    const out = [];
    const walk = (members) => {
      for (const member of this.readingOrder(members)) {
        if (typeof member === "string") continue;
        out.push(member);
        walk(member.members);
      }
    };
    walk(this.groups);
    return out;
  }

  /** The ids of the content cards that are in no group node. */
  rootCards() {
    const inside = new Set(this.groups.flatMap((node) => this.contents(node)));
    return this.grid.cards.map((card) => card.id).filter((id) => !inside.has(id));
  }

  /** The members of a level: of the group node parent, or of the root level for null, with the window sidebars. */
  levelMembers(parent) {
    return parent ? parent.members : [...this.groups, ...this.rootCards()];
  }

  /**
   * Every card in workbench order as {id, node, parent}: the reading order of the root level, each group card before its members in their
   * reading order; node is the group node of a group card and null for a card of the grid, parent the node that holds it or null.
   */
  order() {
    const out = [];
    const walk = (members, parent) => {
      for (const member of this.readingOrder(members)) {
        const node = typeof member === "string" ? null : member;
        out.push({ id: memberId(member), node, parent });
        if (node) walk(node.members, node);
      }
    };
    walk(this.levelMembers(null), null);
    return out;
  }

  /**
   * Walks the group tree from the root level to the card id and returns {path, node, parent}: the group nodes that it passed from the
   * outermost to the innermost, the node of a group card or null, and the node that holds the card or null. A card of the grid that the
   * walk does not meet is a member of the root level; undefined for no card of the space (docs/spec/groups.md#status-and-queries).
   */
  find(id) {
    const walk = (members, path) => {
      for (const member of members) {
        if (memberId(member) === id) {
          return { path, node: typeof member === "string" ? null : member, parent: path.length ? path[path.length - 1] : null };
        }
        if (typeof member === "string") continue;
        const found = walk(member.members, [...path, member]);
        if (found) return found;
      }
      return undefined;
    };
    const found = walk(this.groups, []);
    if (found) return found;
    return this.grid.card(id) ? { path: [], node: null, parent: null } : undefined;
  }

  /** Whether id is a group card. */
  isGroup(id) {
    return Boolean(this.find(id)?.node);
  }

  /** The group node of the group card id, or null. */
  node(id) {
    return this.find(id)?.node ?? null;
  }

  /** The node that holds the card id, or null for the root level; undefined for no card of the space. */
  parentOf(id) {
    return this.find(id)?.parent;
  }

  /** The group path of the card id as core.card.get reports it: one {card, name} per group card that holds it, outermost first. */
  path(id) {
    // default: a card of no space has no group path.
    return (this.find(id)?.path ?? []).map((node) => ({ card: node.card, name: node.name }));
  }

  /** The level of the card id: the number of group cards that hold it. */
  level(id) {
    return this.find(id).path.length;
  }

  /** The leader of the level of parent, or null. */
  leaderOf(parent) {
    return parent ? parent.leader : this.rootLeader;
  }

  setLeaderOf(parent, id) {
    if (parent) parent.leader = id;
    else this.rootLeader = id;
  }

  /** The drawn rectangle {x, y, w, h} of the card id (docs/spec/groups.md#drawn-rectangles), or undefined for no card of the space. */
  rect(id) {
    const found = this.find(id);
    if (!found) return undefined;
    if (found.node) {
      const rects = this.contents(found.node).map((card) => this.grid.rect(card));
      const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
      return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
    }
    const r = this.grid.rect(id);
    const { r0 } = this.grid.card(id);
    const headers = found.path.filter((node) => this.rectangle(node).r0 === r0).length * this.options.head;
    return { x: r.x, y: r.y + headers, w: r.w, h: r.h - headers };
  }

  /** The number of group cards of path, the group cards outside a group card, that start on its first row line r0. */
  headersAbove(path, r0) {
    return path.filter((node) => this.rectangle(node).r0 === r0).length;
  }

  /** The whole state as it stands, which restore puts back. */
  snapshot() {
    const state = this.grid.toJSON();
    return {
      state: { ...state, paidBy: Object.fromEntries(Object.entries(state.paidBy).map(([id, record]) => [id, { ...record }])) },
      groups: structuredClone(this.groups), rootLeader: this.rootLeader, last: this.last,
    };
  }

  restore(kept) {
    this.grid.replace(kept.state);
    this.groups = kept.groups;
    this.rootLeader = kept.rootLeader;
    this.last = kept.last;
  }

  /** The drawn rectangle of every content card by its id. */
  drawnCards() {
    return new Map(this.order().filter(({ id, node }) => !node && !isPlace(id)).map(({ id }) => [id, this.rect(id)]));
  }

  /**
   * The first content card in workbench order whose drawn rectangle differs from before, or is new, and is drawn below minSize, as
   * {id, rect}, or null.
   */
  belowMinimum(before) {
    const { minSize } = this.options;
    for (const [id, rect] of this.drawnCards()) {
      const was = before.get(id);
      if (was && ["x", "y", "w", "h"].every((key) => Math.abs(was[key] - rect[key]) < EPSILON)) continue;
      if (rect.w < minSize - EPSILON || rect.h < minSize - EPSILON) return { id, rect };
    }
    return null;
  }

  /** The text of a content card drawn below its minimum. */
  minimumText(card) {
    const { minSize } = this.options;
    return `card ${card.id} would be ${sizeText(card.rect.w, card.rect.h)}, below its minimum ${sizeText(minSize, minSize)}`;
  }

  /**
   * Runs change on the grid and the tree and keeps its result only when every group card covers one rectangle and no content card that it
   * changed is drawn below its minimum; otherwise everything is put back and the refusal of the card id and the operation text is thrown
   * (docs/spec/groups.md#commands). The error that change throws is thrown after the state is put back.
   */
  attempt(id, operation, change) {
    const before = this.drawnCards();
    const kept = this.snapshot();
    let result;
    try {
      result = change();
      const broken = this.nodes().find((node) => !this.covers(node));
      if (broken) throw new Error(`card ${id} cannot ${operation}: group ${broken.card} would not cover one rectangle`);
      const below = this.belowMinimum(before);
      if (below) throw new Error(`card ${id} cannot ${operation}: ${this.minimumText(below)}`);
    } catch (error) {
      this.restore(kept);
      throw error;
    }
    return result;
  }

  /** Runs change and puts everything back, and returns what change returned or throws what it threw. */
  probe(change) {
    const kept = this.snapshot();
    try {
      return change();
    } finally {
      this.restore(kept);
    }
  }

  /** The next card id of the space. */
  issue() {
    this.last += 1;
    return `card-${this.last}`;
  }

  /** The name 그룹 <n> with the smallest positive n that no group of the space has. */
  nextGroupName() {
    const taken = new Set(this.nodes().map((node) => node.name));
    for (let n = 1; ; n++) if (!taken.has(`그룹 ${n}`)) return `그룹 ${n}`;
  }

  /** Puts member into the level of parent; a content card of the root level is held by no node. */
  attach(parent, member) {
    if (parent) parent.members.push(member);
    else if (typeof member !== "string") this.groups.push(member);
  }

  /** Takes the member id out of the level of parent. */
  detach(parent, id) {
    const members = parent ? parent.members : this.groups;
    const at = members.findIndex((member) => memberId(member) === id);
    if (at >= 0) members.splice(at, 1);
  }

  /** Puts replacement in the place of the member id in the level of parent. */
  replaceMember(parent, id, replacement) {
    const members = parent ? parent.members : this.groups;
    const at = members.findIndex((member) => memberId(member) === id);
    if (at >= 0) members.splice(at, 1, replacement);
    else this.attach(parent, replacement);
  }

  /** Keeps the leader rule of the card id that left the level of parent: the first remaining member that is not a window sidebar leads. */
  leaderLeft(parent, id) {
    if (this.leaderOf(parent) !== id) return;
    const next = this.readingOrder(this.levelMembers(parent)).map(memberId).find((member) => !isPlace(member));
    this.setLeaderOf(parent, next ?? null);
  }

  /** Gives a level without a leader the card id that entered it. */
  leaderEntered(parent, id) {
    if (this.leaderOf(parent) === null && !isPlace(id)) this.setLeaderOf(parent, id);
  }

  /** Replaces each group card that holds one member with that member, which takes its place and its leader mark (docs/spec/groups.md#closing). */
  collapse() {
    for (let single = this.nodes().find((node) => node.members.length === 1); single; single = this.nodes().find((node) => node.members.length === 1)) {
      const parent = this.parentOf(single.card);
      const [only] = single.members;
      const members = parent ? parent.members : this.groups;
      const at = members.indexOf(single);
      if (typeof only === "string" && !parent) members.splice(at, 1);
      else members.splice(at, 1, only);
      if (this.leaderOf(parent) === single.card) this.setLeaderOf(parent, memberId(only));
    }
  }

  /**
   * Splits the rectangle of the group node toward side (docs/spec/groups.md#the-rectangle-of-a-group-card): the card id with data takes
   * the half toward side, and the content cards inside the node are laid into the other half; the cards outside keep their lines.
   */
  splitRectangle(node, side, id, data) {
    const state = this.grid.toJSON();
    const inside = new Set(this.contents(node));
    const box = this.rectangle(node);
    const x = side === "left" || side === "right";
    const lines = x ? state.xs : state.ys;
    const span = x ? [lines[box.c0], lines[box.c1]] : [lines[box.r0], lines[box.r1]];
    const middle = (span[0] + span[1]) / 2;
    const toward = side === "right" || side === "bottom";
    const own = toward ? [span[0], middle] : [middle, span[1]];
    const born = toward ? [middle, span[1]] : [span[0], middle];
    const [lo, hi] = x ? ["x0", "x1"] : ["y0", "y1"];
    const placed = withCoordinates(state).map((item) => (inside.has(item.card.id)
      ? { ...item, [lo]: mapped(item[lo], span, own), [hi]: mapped(item[hi], span, own) } : item));
    const last = placed.reduce((at, item, i) => (inside.has(item.card.id) ? i : at), -1);
    const other = x ? { y0: state.ys[box.r0], y1: state.ys[box.r1] } : { x0: state.xs[box.c0], x1: state.xs[box.c1] };
    placed.splice(last + 1, 0, { card: { id, fixed: false, data }, ...other, [lo]: born[0], [hi]: born[1] });
    this.grid.replace(fromCoordinates(placed, state.paidBy, inside));
  }

  /**
   * Makes the group node one card of the grid with the id of the group card, which spans its rectangle, and returns what unmerge needs to
   * lay the content cards into the rectangle of that card again.
   */
  merge(node) {
    const state = this.grid.toJSON();
    const inside = new Set(this.contents(node));
    const box = this.rectangle(node);
    const span = { x: [state.xs[box.c0], state.xs[box.c1]], y: [state.ys[box.r0], state.ys[box.r1]] };
    const placed = withCoordinates(state);
    const kept = placed.filter((item) => inside.has(item.card.id));
    const first = placed.findIndex((item) => inside.has(item.card.id));
    const rest = placed.filter((item) => !inside.has(item.card.id));
    rest.splice(first, 0, { card: { id: node.card, fixed: false }, x0: span.x[0], x1: span.x[1], y0: span.y[0], y1: span.y[1] });
    this.grid.replace(fromCoordinates(rest, state.paidBy, inside));
    return { kept, span, inside };
  }

  /** Lays the content cards of a merged group node into the rectangle that its card holds now and ends that card. */
  unmerge(node, { kept, span, inside }) {
    const state = this.grid.toJSON();
    const placed = withCoordinates(state);
    const at = placed.findIndex((item) => item.card.id === node.card);
    const { x0, x1, y0, y1 } = placed[at];
    const laid = kept.map((item) => ({
      ...item,
      x0: mapped(item.x0, span.x, [x0, x1]), x1: mapped(item.x1, span.x, [x0, x1]),
      y0: mapped(item.y0, span.y, [y0, y1]), y1: mapped(item.y1, span.y, [y0, y1]),
    }));
    placed.splice(at, 1, ...laid);
    this.grid.replace(fromCoordinates(placed, state.paidBy, new Set([...inside, node.card])));
  }

  /**
   * Balances the grid after the split of the card id toward side (cardSplit even), and refuses the split when the balance fails or draws
   * a content card that it changed below its minimum (docs/spec/groups.md#split-setting).
   */
  balanceEven(id, side, before) {
    let balanced;
    try {
      balanced = this.grid.balance();
    } catch (error) {
      throw new Error(`card ${id} cannot split toward ${side}: cardSplit even cannot balance the grid: ${error.message}`);
    }
    if (!balanced) throw new Error(`card ${id} cannot split toward ${side}: cardSplit even cannot balance the grid: the grid is not a slicing arrangement`);
    const below = this.belowMinimum(before);
    if (below) {
      throw new Error(`card ${id} cannot split toward ${side}: cardSplit even would draw card ${below.id} at ${sizeText(below.rect.w, below.rect.h)}, ` +
        `below its minimum ${sizeText(this.options.minSize, this.options.minSize)}`);
    }
  }

  /** Finds the card id of the space, or refuses it. */
  require(id) {
    const found = this.find(id);
    if (!found) throw new Error(`no card ${id}`);
    return found;
  }

  /**
   * Groups the card id, a content card or a group card, with a new content card with data toward side and returns {group, card}, the
   * group card and the new card (docs/spec/groups.md#commands). even balances the grid after the split (cardSplit even).
   */
  create(id, side, data, even) {
    if (isPlace(id)) throw new Error(`card ${id} is a window sidebar; a group holds content cards and group cards`);
    if (!SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
    const found = this.require(id);
    const before = this.drawnCards();
    return this.attempt(id, `hold a group toward ${side}`, () => {
      const group = this.issue();
      const born = this.issue();
      if (found.node) this.splitRectangle(found.node, side, born, data);
      else if (this.grid.splitToward(id, side, { id: born, data }) === null) throw new Error(`card ${id} cannot hold a group toward ${side}`);
      const parent = this.parentOf(id);
      const node = { card: group, name: this.nextGroupName(), leader: id, members: [found.node ?? id, born] };
      this.replaceMember(parent, id, node);
      if (this.leaderOf(parent) === id) this.setLeaderOf(parent, group);
      if (even) this.balanceEven(id, side, before);
      return { group, card: born };
    });
  }

  /**
   * Puts a new content card with data beside the card id toward side and returns its id: a split of the library for a content card, which
   * joins the group of the card, and the split of the rectangle for a group card, which joins the level that holds it. even balances the
   * grid after the split (cardSplit even).
   */
  split(id, side, data, even) {
    const refusal = () => new Error(`card ${id} cannot split toward ${side}`);
    const found = this.find(id);
    if (!found || isPlace(id) || !SIDES.includes(side)) throw refusal();
    const before = this.drawnCards();
    return this.attempt(id, `split toward ${side}`, () => {
      const born = this.issue();
      if (found.node) this.splitRectangle(found.node, side, born, data);
      else if (this.grid.splitToward(id, side, { id: born, data }) === null) throw refusal();
      this.attach(found.parent, born);
      this.leaderEntered(found.parent, born);
      if (even) this.balanceEven(id, side, before);
      return born;
    });
  }

  /** Whether split of the card id toward side would succeed. */
  canSplit(id, side, even) {
    return this.probe(() => {
      try {
        this.split(id, side, undefined, even);
        return true;
      } catch {
        // silent: the probe answers whether the split succeeds; the refusal is the answer false.
        return false;
      }
    });
  }

  /**
   * Adds a content card with data inside the group card id at the right edge of its rectangle, by the split of the rectangle toward right,
   * and returns its id (docs/spec/groups.md#card-commands-on-a-group-card). even balances the grid after the add (cardSplit even).
   */
  addCard(id, data, even) {
    const node = this.requireGroup(id);
    const before = this.drawnCards();
    return this.attempt(id, "split toward right", () => {
      const born = this.issue();
      this.splitRectangle(node, "right", born, data);
      node.members.push(born);
      if (even) this.balanceEven(id, "right", before);
      return born;
    });
  }

  /**
   * Closes the card id with every card inside it and returns the content cards that ended, in workbench order. A group card is made one
   * card and closed with the close of the library (R7); a group card left with one member is replaced by it.
   */
  close(id) {
    const refusal = () => new Error(`card ${id} cannot close`);
    const found = this.find(id);
    if (!found) throw refusal();
    const ended = found.node ? this.order().filter(({ id: card, node }) => !node && this.contents(found.node).includes(card)).map(({ id: card }) => card) : [id];
    this.attempt(id, "close", () => {
      if (found.node) this.merge(found.node);
      if (!this.grid.close(id)) throw refusal();
      this.detach(found.parent, id);
      this.leaderLeft(found.parent, id);
      this.collapse();
    });
    return ended;
  }

  /** Whether close of the card id would succeed. */
  canClose(id) {
    return this.probe(() => {
      try {
        this.close(id);
        return true;
      } catch {
        // silent: the probe answers whether the close succeeds; the refusal is the answer false.
        return false;
      }
    });
  }

  /** The group node of id; an id that is no group card is refused. */
  requireGroup(id) {
    const node = this.node(id);
    if (!node) throw new Error(`card ${id} is not a group`);
    return node;
  }

  /** Replaces the group card id with its members in the level that holds it; the grid does not change. */
  dissolve(id) {
    const node = this.requireGroup(id);
    const parent = this.parentOf(id);
    const members = parent ? parent.members : this.groups;
    const kept = parent ? node.members : node.members.filter((member) => typeof member !== "string");
    members.splice(members.indexOf(node), 1, ...kept);
    if (this.leaderOf(parent) === id) this.setLeaderOf(parent, node.leader);
  }

  /** Sets the name of the group card id to name with the white space at both ends removed, and returns the name. */
  rename(id, name) {
    const node = this.requireGroup(id);
    const trimmed = name.trim();
    const count = [...trimmed].length;
    if (count < 1 || count > 40) throw new Error(`group name must be 1 to 40 characters: ${trimmed}`);
    node.name = trimmed;
    return trimmed;
  }

  /** Makes the card id the leader of its level and returns the group card of that level, or null for the root level. */
  setLeader(id) {
    if (isPlace(id)) throw new Error(`card ${id} is a window sidebar and cannot lead a level`);
    const { parent } = this.require(id);
    this.setLeaderOf(parent, id);
    return parent ? parent.card : null;
  }

  /** The refusal of a move of the card id to side of target, or null (docs/spec/groups.md#commands). */
  checkMove(id, target, side) {
    if (isPlace(id)) return new Error(`card ${id} is a window sidebar and does not move`);
    if (isPlace(target)) return new Error(`card ${target} is a window sidebar; a card does not move beside it`);
    if (target === id || (this.find(target)?.path ?? []).some((node) => node.card === id)) return new Error(`card ${id} cannot move into itself`);
    if (side === "centre" && !this.isGroup(target)) return new Error(`card ${target} is not a group; a card moves beside it`);
    return null;
  }

  /**
   * The member of the level of card whose box lies against the box of card toward side and spans the same two lines across that side, or
   * null.
   */
  neighbour(card, side) {
    const found = this.find(card);
    if (!found) return null;
    const from = this.box(found.node ?? card);
    for (const member of this.levelMembers(found.parent)) {
      const id = memberId(member);
      if (id === card || isPlace(id)) continue;
      const other = this.box(member);
      const rows = other.r0 === from.r0 && other.r1 === from.r1;
      const columns = other.c0 === from.c0 && other.c1 === from.c1;
      if ((side === "right" && rows && other.c0 === from.c1) || (side === "left" && rows && other.c1 === from.c0) ||
        (side === "bottom" && columns && other.r0 === from.r1) || (side === "top" && columns && other.r1 === from.r0)) return id;
    }
    return null;
  }

  /** Whether the card id already stands where a move to side of target puts it (docs/spec/groups.md#idempotency). */
  moved(id, target, side) {
    const found = this.find(id);
    if (!found) return false;
    if (side === "centre") {
      if (found.parent?.card !== target) return false;
      const box = this.box(found.node ?? id);
      const outer = this.rectangle(found.parent);
      return box.c1 === outer.c1 && box.r0 === outer.r0 && box.r1 === outer.r1;
    }
    return this.parentOf(target) === found.parent && this.neighbour(target, side) === id;
  }

  /**
   * Moves the card id, a content card or a group card, beside target on side into the level of target, or with side centre into the group
   * card target at the right edge of its rectangle (docs/spec/groups.md#commands). The card keeps its id.
   */
  move(id, target, side) {
    const refused = this.checkMove(id, target, side);
    if (refused) throw refused;
    const refusal = () => new Error(`card ${id} cannot move to ${side} of ${target}`);
    if (side !== "centre" && !SIDES.includes(side)) throw refusal();
    const found = this.find(id);
    if (!found || !this.find(target)) throw refusal();
    if (this.moved(id, target, side)) return;
    this.attempt(id, `move to ${side} of ${target}`, () => {
      const data = found.node ? undefined : this.grid.card(id).data;
      this.detach(found.parent, id);
      this.leaderLeft(found.parent, id);
      if (side === "centre") {
        const into = this.node(target);
        const merged = found.node ? this.merge(found.node) : null;
        if (!this.grid.close(id)) throw refusal();
        this.splitRectangle(into, "right", id, data);
        if (merged) this.unmerge(found.node, merged);
        into.members.push(found.node ?? id);
        this.leaderEntered(into, id);
        this.collapse();
        return;
      }
      // The target is resolved before the replacement, so a group that the card leaves with one member is the member that replaces it.
      const left = this.node(target);
      const landing = left && left.members.length === 1 ? memberId(left.members[0]) : target;
      this.collapse();
      const merged = found.node ? this.merge(found.node) : null;
      const beside = this.node(landing);
      if (beside) {
        if (!this.grid.close(id)) throw refusal();
        this.splitRectangle(beside, side, id, data);
      } else if (!this.grid.move(id, landing, side)) {
        throw refusal();
      }
      if (merged) this.unmerge(found.node, merged);
      const parent = this.parentOf(landing);
      this.attach(parent, found.node ?? id);
      this.leaderEntered(parent, id);
    });
  }

  /**
   * The content card that a focus of the card id gives: the card itself, or for a group card the first content card inside it in
   * workbench order.
   */
  focusable(id) {
    const node = this.node(id);
    if (!node) return id;
    const inside = new Set(this.contents(node));
    return this.order().find((entry) => !entry.node && inside.has(entry.id)).id;
  }

  /**
   * Resolves a drop at x, y from the root level inward (docs/spec/groups.md#moving-and-dropping) and returns {card, zone} or null: a point
   * in the drawn rectangle of a group card of a level is on its header the centre, in the outer quarter of its body a side, and otherwise
   * goes on to its members; a point in no group card of the level is resolved by zoneAt of the grid. options are the headerPx and edge of
   * zoneAt and without, a dragged group card that the resolution leaves out with the cards inside it.
   */
  dropAt(x, y, options) {
    const { without = null, ...zone } = options;
    // default: edge is an optional option of zoneAt, documented as 0.25.
    const edge = zone.edge ?? 0.25;
    let members = this.groups;
    for (;;) {
      const hit = members.find((member) => {
        if (typeof member === "string") return false;
        const r = this.rect(member.card);
        return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      });
      if (!hit) break;
      if (hit.card === without) return null;
      const r = this.rect(hit.card);
      const top = r.y + (this.headersAbove(this.find(hit.card).path, this.rectangle(hit).r0) + 1) * this.options.head;
      const bottom = r.y + r.h;
      if (y < top || bottom <= top || !(r.w > 0)) return { card: hit.card, zone: "centre" };
      const px = (x - r.x) / r.w;
      const py = (y - top) / (bottom - top);
      if (!(px > edge && px < 1 - edge && py > edge && py < 1 - edge)) {
        const nearest = Math.min(px, 1 - px, py, 1 - py);
        return { card: hit.card, zone: nearest === px ? "left" : nearest === 1 - px ? "right" : nearest === py ? "top" : "bottom" };
      }
      members = hit.members;
    }
    const hit = this.grid.zoneAt(x, y, zone);
    if (!hit) return null;
    const dragged = without ? this.node(without) : null;
    if (dragged && this.contents(dragged).includes(hit.id)) return null;
    return { card: hit.id, zone: hit.zone };
  }

  /** A group node in its stored form, its members in reading order; level adds the level of its members. */
  storedNode(node, level, depth) {
    const out = {
      card: node.card, name: node.name, leader: node.leader,
      members: this.readingOrder(node.members).map((member) => (typeof member === "string" ? member : this.storedNode(member, level, depth + 1))),
    };
    if (level) out.level = depth;
    return out;
  }

  /**
   * The stored form of the layout (docs/spec/groups.md#storage): {state, groups, leader, lastCard}, the grid, the group nodes of the root
   * level in reading order, the leader of the root level or null, and lastCard.
   */
  stored() {
    return {
      state: this.grid.toJSON(),
      groups: this.readingOrder(this.groups).map((node) => this.storedNode(node, false, 1)),
      leader: this.rootLeader, lastCard: this.last,
    };
  }

  /** The group nodes of the root level as core.layout reports them, each with the level of its members. */
  tree() {
    return this.readingOrder(this.groups).map((node) => this.storedNode(node, true, 1));
  }

  /** The node of the group card id as core.card.get reports it: {name, level, leader, members} with the level of its members. */
  groupRecord(id) {
    const { card: _card, ...record } = this.storedNode(this.requireGroup(id), true, this.level(id) + 1);
    return record;
  }

  /** Sets the data of the content card id. */
  setData(id, data) {
    if (this.isGroup(id) || !this.grid.setData(id, data)) throw new Error(`no content card ${id}`);
  }
}

/** A group tree without groups over grid, with the leader of the root level, null without one, and lastCard. */
export const newGroupTree = (grid, options, leader, last) => new GroupTree(grid, options, [], leader, last);

/**
 * Reads the stored layout of a space, {state, groups, leader, lastCard}, into grid and returns its group tree; each refusal throws the
 * text of docs/spec/groups.md#storage without the prefix that names the file, the project and the space. A member that is absent is
 * undefined.
 */
export function readGroupTree({ state, groups, leader, lastCard }, options, grid) {
  checkState(state);
  const cards = new Set(state.cards.map((card) => card.id));
  if (!Array.isArray(groups)) throw new Error(`layout stores groups ${JSON.stringify(groups) ?? "undefined"}, which is not a list of groups`);
  const seen = new Set();
  const nodes = groups.map((node) => readNode(node, cards, seen));
  const tree = new GroupTree(grid, options, nodes, null, 0);
  grid.replace(state);
  const members = [...nodes.map((node) => node.card), ...state.cards.map((card) => card.id).filter((id) => !seen.has(id))];
  tree.rootLeader = readLeader("root", members, leader, true);
  for (const node of tree.nodes()) {
    if (!tree.covers(node)) throw new Error(`group ${node.card} does not cover one rectangle of the grid`);
  }
  const refused = new Error(`layout stores lastCard ${JSON.stringify(lastCard) ?? "undefined"}, which is not the largest issued card number`);
  if (!Number.isInteger(lastCard) || lastCard < 1 || lastCard > LAST_LIMIT) throw refused;
  for (const id of [...cards, ...seen]) {
    const n = cardNumber(id);
    if (n !== null && n > lastCard) throw refused;
  }
  tree.last = lastCard;
  return tree;
}

/** Reads one stored group node and the nodes inside it; seen collects the identifiers of the tree. */
function readNode(node, cards, seen) {
  const keys = isObject(node) ? Object.keys(node).sort().join(",") : "";
  if (keys !== "card,leader,members,name" || typeof node.card !== "string" || !Array.isArray(node.members)) {
    throw new Error(`layout stores the group ${JSON.stringify(node)}, which is not {card, name, leader, members}`);
  }
  const { card: id, name } = node;
  if (typeof name !== "string" || [...name].length < 1 || [...name].length > 40 || name.trim() !== name) {
    throw new Error(`group ${id} stores the name ${JSON.stringify(name)}, which is not 1 to 40 characters`);
  }
  if (cards.has(id) || seen.has(id)) throw new Error(`card ${id} is stored twice`);
  seen.add(id);
  if (node.members.length < 2) throw new Error(`group ${id} holds fewer than two cards`);
  const members = node.members.map((member) => {
    if (isObject(member)) return readNode(member, cards, seen);
    if (typeof member === "string" && isPlace(member)) throw new Error(`group ${id} holds the window sidebar ${member}`);
    if (typeof member !== "string" || !cards.has(member)) throw new Error(`group ${id} holds ${JSON.stringify(member)}, which is not a content card of the layout`);
    if (seen.has(member)) throw new Error(`card ${member} is stored twice`);
    seen.add(member);
    return member;
  });
  return { card: id, name, leader: readLeader(`group ${id}`, members.map(memberId), node.leader, false), members };
}

/** Reads the stored leader of a level, named label in a refusal, among the identifiers of its members. */
function readLeader(label, members, leader, root) {
  if (leader === undefined || leader === null) {
    if (leader === undefined || !root || members.some((id) => !isPlace(id))) throw new Error(`level ${label} has no leader`);
    return null;
  }
  if (typeof leader !== "string" || !members.includes(leader)) {
    throw new Error(`level ${label} names the leader ${typeof leader === "string" ? leader : JSON.stringify(leader)}, which is not a member of that level`);
  }
  if (isPlace(leader)) throw new Error(`level ${label} names the window sidebar ${leader} as its leader`);
  return leader;
}
