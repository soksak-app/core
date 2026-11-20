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
export const memberId = (member) => (typeof member === "string" ? member : member.card);

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
/** How far a line may reach into a header or a frame across the line, in px: a divider at the side of a group card touches the end of its
 * header by less than this. */
const HEAD_TOLERANCE = 1;

/** The extent [a0, a1] across its line of a rule or a divider of axis. */
const across = (r) => (r.axis === "y" ? [r.y, r.y + r.h] : [r.x, r.x + r.w]);

/** The stretch [from, to] along its line of a rule or a divider of axis. */
const along = (r) => (r.axis === "y" ? [r.x, r.x + r.w] : [r.y, r.y + r.h]);

/** The position and the size along its line of a rule or a divider of axis that covers the stretch part. */
const stretch = (axis, [from, to]) => (axis === "y" ? { x: from, w: to - from } : { y: from, h: to - from });

/** The extent across and the stretch along a line of axis of a rectangle. */
const spanOf = (axis, r) => (axis === "y" ? [r.y, r.y + r.h, r.x, r.x + r.w] : [r.x, r.x + r.w, r.y, r.y + r.h]);

/** The parts of the stretch part that the rectangles boxes take out of it, for a line of axis across [a0, a1]. */
function cutOut(axis, [a0, a1], parts, boxes) {
  for (const box of boxes) {
    const [h0, h1, s0, s1] = spanOf(axis, box);
    if (Math.min(a1, h1) - Math.max(a0, h0) <= HEAD_TOLERANCE) continue;
    parts = parts.flatMap(([from, to]) => {
      if (to <= s0 || from >= s1) return [[from, to]];
      return [...(from < s0 ? [[from, s0]] : []), ...(to > s1 ? [[s1, to]] : [])];
    });
  }
  return parts;
}

/** The parts of the stretch part along a line of axis across [a0, a1] that cross no header that the line reaches into. */
const clearOfHeads = (axis, extent, part, heads) => cutOut(axis, extent, [part], heads);

/**
 * The stretch part of a line of axis across [a0, a1] cut by the group cards, groups of {frame, inner}: inside the innermost frame that holds
 * the middle of the stretch and the line it keeps only the inside of that frame below its header; outside every frame it loses every
 * stretch where it would cross a frame. Each cut is {from, to, outside}.
 */
function clearOfFrames(axis, [a0, a1], part, groups) {
  const middle = (part[0] + part[1]) / 2;
  let holder = null;
  for (const group of groups) {
    const [c0, c1, s0, s1] = spanOf(axis, group.frame);
    if (a0 >= c0 && a1 <= c1 && middle > s0 && middle < s1 && (holder === null || holder.frame.w * holder.frame.h > group.frame.w * group.frame.h)) {
      holder = group;
    }
  }
  if (holder) {
    const [, , s0, s1] = spanOf(axis, holder.inner);
    const from = Math.max(part[0], s0), to = Math.min(part[1], s1);
    return to > from ? [{ from, to, outside: false }] : [];
  }
  return cutOut(axis, [a0, a1], [part], groups.map((group) => group.frame)).map(([from, to]) => ({ from, to, outside: true }));
}

export class GroupTree {
  /**
   * grid is the grid of the space; options are the gap, the smallest drawn edge of a content card (minSize), the head height of a
   * group header (head) and whether the cards share one line at the seam, where a frame and a header take no gap (seam); groups are the group nodes of the root level, leader the leader of the root level or null, last lastCard.
   */
  constructor(grid, options, groups, leader, last) {
    this.grid = grid;
    this.options = { ...options };
    this.groups = groups;
    this.rootLeader = leader;
    this.last = last;
    /** The frames of each content card by id that reframe gave the grid. */
    this.frames = {};
    /** The number of trial operations that probe ran. */
    this.probes = 0;
    /** The answers of canSplit, canGroup and canClose by key for the layout that answersToken describes. */
    this.answers = new Map();
    this.answersToken = null;
  }

  /**
   * Changes the gap, the smallest edge, the head height and the seam, and gives the grid the frames of that drawing. The grid keeps its
   * proportions (R5).
   */
  setOptions(options) {
    this.options = { ...options };
    this.grid.gap = options.gap;
    this.reframe();
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

  /**
   * The cards of the grid that hold the cells of a group node: its content cards, or the card of a group node inside it that an operation in
   * progress merged into one card; a card that the operation took out of the grid is left out.
   */
  held(node) {
    if (this.grid.card(node.card)) return [this.grid.card(node.card)];
    return node.members.flatMap((member) => (typeof member === "string" ? [this.grid.card(member)].filter(Boolean) : this.held(member)));
  }

  /** The rectangle of a group node in line indices: the span of the content cards inside it. */
  rectangle(node) {
    const boxes = this.held(node);
    return {
      c0: Math.min(...boxes.map((card) => card.c0)), c1: Math.max(...boxes.map((card) => card.c1)),
      r0: Math.min(...boxes.map((card) => card.r0)), r1: Math.max(...boxes.map((card) => card.r1)),
    };
  }

  /**
   * Whether the cards that hold the cells of a group node (held) hold exactly the cells of their span. A card that an operation in progress
   * took out of the grid counts no cell, and a group node without a card in the grid covers its rectangle, the card that replaced it.
   */
  covers(node) {
    const present = this.held(node);
    if (!present.length) return true;
    const c0 = Math.min(...present.map((card) => card.c0)), c1 = Math.max(...present.map((card) => card.c1));
    const r0 = Math.min(...present.map((card) => card.r0)), r1 = Math.max(...present.map((card) => card.r1));
    const cells = present.reduce((n, card) => n + (card.c1 - card.c0) * (card.r1 - card.r0), 0);
    return cells === (c1 - c0) * (r1 - r0);
  }

  /**
   * Every group node of the tree in workbench order. The members of a group node that an operation in progress merged into one card are
   * not in the grid, so the walk does not enter it.
   */
  nodes() {
    const out = [];
    const walk = (members) => {
      for (const member of this.readingOrder(members)) {
        if (typeof member === "string") continue;
        out.push(member);
        if (!this.grid.card(member.card)) walk(member.members);
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

  /**
   * The number of levels from the content card focused up to the group card id that holds it, 1 for the group card that holds it
   * directly, or null when focused is null or stands outside id (docs/spec/groups.md#focus).
   */
  focusDistance(id, focused) {
    // default: no focused card, or a focused card of no space, lies inside no group card.
    const path = focused === null ? [] : (this.find(focused)?.path ?? []);
    const index = path.findIndex((node) => node.card === id);
    return index < 0 ? null : path.length - index;
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
    if (found.node) return this.frameRect(found.node, found.path);
    // A content card is drawn below the headers of the group cards that hold it and start on its first row line.
    const r = this.grid.rect(id);
    const headers = this.headersAbove(found.path, this.grid.card(id).r0) * this.headStep();
    return { x: r.x, y: r.y + headers, w: r.w, h: r.h - headers };
  }

  /**
   * The frame of a group node that the group nodes path hold (docs/spec/groups.md#drawn-rectangles): the rectangle between its lines, each
   * inset by its corridor and by one gap for each node of path that ends on it, the top line by the headers of the nodes of path that start
   * on it.
   */
  frameRect(node, path) {
    return this.place(null, null, path, this.rectangle(node));
  }

  /**
   * The rectangle between the lines of span, {c0, c1, r0, r1}, of a box that the group nodes holders hold
   * (docs/spec/groups.md#drawn-rectangles): each line inset by its corridor and by one gap for each holder that ends on it, the top line
   * by the headers of the holders that start on it. With onto, the lines of the group node whole are stretched onto the rectangle onto and
   * its own lines take no corridor, as the border of the plane takes none.
   */
  place(onto, whole, holders, span) {
    // The rectangle of the layout library between the lines, without frames: the frames of the library belong to the cards by id, and no
    // card has the empty id. Its edges stand the corridor of each line from the line.
    const bare = this.grid.rectOf({ id: "", fixed: false, ...span });
    const at = (axis, line) => this.grid.boundaryPos(axis, line);
    const lines = whole && this.rectangle(whole);
    const pos = (axis, line, lo, hi, from, size) =>
      (onto ? from + (at(axis, line) - at(axis, lines[lo])) * size / (at(axis, lines[hi]) - at(axis, lines[lo])) : at(axis, line));
    const own = (line, lo, hi) => onto !== null && (line === lines[lo] || line === lines[hi]);
    const inset = {
      c0: own(span.c0, "c0", "c1") ? 0 : bare.x - at("x", span.c0),
      c1: own(span.c1, "c0", "c1") ? 0 : at("x", span.c1) - bare.x - bare.w,
      r0: own(span.r0, "r0", "r1") ? 0 : bare.y - at("y", span.r0),
      r1: own(span.r1, "r0", "r1") ? 0 : at("y", span.r1) - bare.y - bare.h,
    };
    const ends = (key) => holders.filter((holder) => this.rectangle(holder)[key] === span[key]).length;
    // default: without onto the lines stand where the grid draws them.
    const { x: ox, y: oy, w: ow, h: oh } = onto ?? { x: 0, y: 0, w: 0, h: 0 };
    const x0 = pos("x", span.c0, "c0", "c1", ox, ow) + inset.c0 + ends("c0") * this.frameUnit("x");
    const x1 = pos("x", span.c1, "c0", "c1", ox, ow) - inset.c1 - ends("c1") * this.frameUnit("x");
    const y0 = pos("y", span.r0, "r0", "r1", oy, oh) + inset.r0 + this.headersAbove(holders, span.r0) * this.headStep();
    const y1 = pos("y", span.r1, "r0", "r1", oy, oh) - inset.r1 - ends("r1") * this.frameUnit("y");
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  /**
   * The rectangle of each card inside the group card id while it is shown across the rectangle area, laid out as if it were the whole
   * space (docs/spec/groups.md#card-commands-on-a-group-card): its frame is area, the lines inside it are stretched onto area while every
   * corridor and frame keeps the gap, and each card inside it stands below the headers of the group cards between it and id that start on
   * its first row line. A Map by card id with id itself, or null for no group card.
   */
  fullscreen(id, area) {
    const whole = this.node(id);
    if (!whole) return null;
    const out = new Map([[id, area]]);
    for (const { id: card, node } of this.order()) {
      const { path } = this.find(card);
      const at = path.indexOf(whole);
      if (card === id || at < 0) continue;
      out.set(card, this.place(area, whole, path.slice(at), node ? this.rectangle(node) : this.box(card)));
    }
    return out;
  }

  /** Whether a group split button of the card id toward side is enabled: a group of the card and a new card toward side would succeed. */
  canGroup(id, side) {
    return this.answer(`group:${id}:${side}`, () => this.probe(() => {
      try {
        this.create(id, side, undefined);
        return true;
      } catch {
        // silent: the probe answers whether the group succeeds; the refusal is the answer false.
        return false;
      }
    }));
  }

  /** The number of members of the level of parent, null for the root level, that can lead it: every member but a window sidebar. */
  leadCount(parent) {
    return this.levelMembers(parent).map(memberId).filter((id) => !isPlace(id)).length;
  }

  /** The headers of the group cards, in workbench order. */
  headRects() {
    return this.order().filter(({ node }) => node).map(({ id }) => this.headRect(id));
  }

  /**
   * The dividers of the grid cut where they would cross a group header (docs/spec/groups.md#drawing): a divider of a line inside a group
   * starts below the stacked headers. A divider cut in parts keeps its key on the first part, and the next parts add their index. Each part
   * draws its grip, gripLength long, at its center while it holds the grip (grip), so no grip reaches into a header.
   */
  drawnDividers(dividers, gripLength) {
    const heads = this.headRects();
    return dividers.flatMap((divider) => clearOfHeads(divider.axis, across(divider), along(divider), heads)
      .map((part, k) => ({ ...divider, ...stretch(divider.axis, part), key: k > 0 ? `${divider.key}:${k}` : divider.key,
        grip: part[1] - part[0] >= gripLength })));
  }

  /**
   * The rules of the grid as drawn (docs/spec/groups.md#drawing), each with bleed: each cut where it would cross a header, a stretch inside
   * a group card cut to the inside of its frame below its header, which keeps out of the stage padding, and a stretch outside every group
   * card cut where it would cross a frame, which alone reaches into the stage padding at the edge of the plane.
   */
  drawnRules(rules) {
    const heads = this.headRects();
    const groups = this.order().filter(({ node }) => node).map(({ id }) => {
      const frame = this.rect(id), head = this.headRect(id);
      return { frame, inner: { x: frame.x, y: head.y + head.h, w: frame.w, h: frame.y + frame.h - head.y - head.h } };
    });
    return rules.flatMap((rule) => {
      const cuts = clearOfHeads(rule.axis, across(rule), along(rule), heads).flatMap((part) => clearOfFrames(rule.axis, across(rule), part, groups));
      return cuts.map((cut, k) => ({ ...rule, ...stretch(rule.axis, [cut.from, cut.to]), bleed: cut.outside,
        key: k > 0 ? `${rule.key}:${k}` : rule.key }));
    });
  }


  /**
   * The length that one frame takes on axis, which the layout library reduces with the corridor when the plane cannot hold the corridors
   * and the frames (R5): read off a content card with a frame on its left or its bottom side that is drawn with a size on axis, as the
   * distance between its edge and the edge of the same span without frames; 0 when no such card stands.
   */
  frameUnit(axis) {
    for (const [id, frames] of Object.entries(this.frames)) {
      const card = this.grid.card(id);
      // An operation in progress can take a card out of the grid before the next reframe.
      if (!card) continue;
      const drawn = this.grid.rect(id);
      const bare = this.grid.rectOf({ ...card, id: "" });
      if (axis === "x" && frames.left > 0 && drawn.w > 0) return (drawn.x - bare.x) / frames.left;
      if (axis === "y" && frames.bottom > 0 && drawn.h > 0) return (bare.y + bare.h - drawn.y - drawn.h) / frames.bottom;
    }
    return 0;
  }

  /**
   * Gives the grid the frames of every content card (docs/spec/groups.md#drawn-rectangles): on its left, right and bottom side the number of
   * group cards that hold it and end on the line of that side. The top takes no frame, because the header of a group card stands inside its
   * frame at the top. A card of no group, a window sidebar among them, has none, and at the seam, where a frame takes no gap, no card has
   * a frame.
   */
  reframe() {
    const frames = {};
    for (const card of this.options.seam ? [] : this.grid.cards) {
      // default: a card that the walk does not meet holds no group.
      const path = this.find(card.id)?.path ?? [];
      const counts = { left: 0, right: 0, top: 0, bottom: 0 };
      for (const node of path) {
        const span = this.rectangle(node);
        if (span.c0 === card.c0) counts.left++;
        if (span.c1 === card.c1) counts.right++;
        if (span.r1 === card.r1) counts.bottom++;
      }
      if (counts.left || counts.right || counts.bottom) frames[card.id] = counts;
    }
    this.frames = frames;
    this.grid.setFrames(frames);
  }

  /** The header of the group card id: a row of the head height at the top of its drawn rectangle, across its whole width. */
  headRect(id) {
    const { x, y, w } = this.rect(id);
    return { x, y, w, h: this.options.head };
  }

  /**
   * How far one header moves the boxes below it down: the header and the corridor that separates it from them, as between two cards, and
   * the header alone at the seam, where its bottom line is the line between them (docs/spec/groups.md#drawn-rectangles).
   */
  headStep() {
    return this.options.seam ? this.options.head : this.options.head + this.grid.gap;
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
    this.reframe();
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

  /**
   * The text of a split of the card id toward side that the layout library refuses at any minimum: the card is drawn narrower than the
   * corridor that the split adds, so its halves would have no extent on the axis of side.
   */
  noRoomText(id, side) {
    const { w, h } = this.rect(id);
    const axis = side === "left" || side === "right" ? "x" : "y";
    return this.minimumText({ id, rect: { w: axis === "x" ? 0 : w, h: axis === "y" ? 0 : h } });
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
      // The space holds a group after the change also when the change made the first one.
      this.keepForm();
      const broken = this.nodes().find((node) => !this.covers(node));
      if (broken) throw new Error(`card ${id} cannot ${operation}: group ${broken.card} would not cover one rectangle`);
      const breach = this.formBreach();
      if (breach) throw new Error(`card ${id} cannot ${operation}: ${this.breachText(breach)}`);
      const below = this.belowMinimum(before);
      if (below) throw new Error(`card ${id} cannot ${operation}: ${this.minimumText(below)}`);
    } catch (error) {
      this.restore(kept);
      throw error;
    }
    return result;
  }

  /**
   * Removes the lines that no card uses and every paidBy record of the grid while the space holds a group card, so a later close gives its
   * cells to the neighbours that the layout library chooses and a later split lands in the middle of its card
   * (docs/spec/groups.md#model). A space without groups keeps what the library keeps.
   */
  keepForm() {
    this.reframe();
    if (this.groups.length === 0) return;
    this.grid.tidy();
    const state = this.grid.toJSON();
    if (Object.keys(state.paidBy).length) this.grid.replace({ ...state, paidBy: {} });
    // Two lines at one coordinate, which a space without groups can hold, become one line.
    for (const axis of ["x", "y"]) {
      for (let k = this.grid.lines(axis).length - 2; k >= 1; k--) {
        const lines = this.grid.lines(axis);
        if (k < lines.length - 1 && Math.abs(lines[k] - lines[k - 1]) < EPSILON) this.grid.mergeCoincident(axis, k);
      }
    }
    this.reframe();
  }

  /**
   * The first breach of the form of a space with groups other than a group that does not cover its rectangle, or null: two lines of an
   * axis at one coordinate around a slot that no card with a px size holds, {axis, line}, the first of them, x before y, or two group cards
   * that overlap without one holding the other, {groups: [a, b]} in workbench order (docs/spec/groups.md#model).
   */
  formBreach() {
    if (this.groups.length === 0) return null;
    const state = this.grid.toJSON();
    for (const [axis, lines, lo, hi, size] of [["x", state.xs, "c0", "c1", "width"], ["y", state.ys, "r0", "r1", "height"]]) {
      for (let k = 0; k + 1 < lines.length; k++) {
        const sized = state.cards.some((card) => card[lo] === k && card[hi] === k + 1 && card[size] !== undefined);
        if (!sized && !(lines[k + 1] > lines[k])) return { axis, line: k };
      }
    }
    const boxes = this.nodes().map((node) => ({ card: node.card, ...this.rectangle(node) }));
    const holds = (p, q) => p.c0 <= q.c0 && p.c1 >= q.c1 && p.r0 <= q.r0 && p.r1 >= q.r1;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const apart = a.c1 <= b.c0 || b.c1 <= a.c0 || a.r1 <= b.r0 || b.r1 <= a.r0;
        if (!apart && !holds(a, b) && !holds(b, a)) return { groups: [a.card, b.card] };
      }
    }
    return null;
  }

  /** The text of a breach of formBreach after an operation. */
  breachText(breach) {
    return breach.groups ? `groups ${breach.groups[0]} and ${breach.groups[1]} would overlap`
      : `the ${breach.axis} lines ${breach.line} and ${breach.line + 1} would stand at one coordinate`;
  }

  /**
   * Moves the boundary line of axis toward px, as moveBoundary of the grid does across every group, and stops at the last position at
   * which every content card that the move changes is drawn at least minSize (docs/spec/groups.md#minimum-size). In a space with groups a
   * line that ends on the coordinate of another line merges onto it, as at the end of a drag. Returns where the boundary stands.
   */
  moveBoundary(axis, line, px, allowSnap) {
    const at = this.placeBoundary(axis, line, px, allowSnap);
    this.keepForm();
    return at;
  }

  /**
   * The centring of a boundary as centerBoundary of the grid does; a centring that would draw a content card that it changes below its
   * minimum leaves the line where it stands, and in a space with groups the line merges onto a line that it reaches
   * (docs/spec/groups.md#commands). Returns where the boundary stands.
   */
  centerBoundary(axis, line) {
    const before = this.drawnCards();
    const kept = this.snapshot();
    const at = this.grid.centerBoundary(axis, line);
    if (this.belowMinimum(before)) {
      this.restore(kept);
      return this.grid.boundaryPos(axis, line);
    }
    this.keepForm();
    return at;
  }

  /** moveBoundary without the merge of the lines that meet. */
  placeBoundary(axis, line, px, allowSnap) {
    const from = this.grid.boundaryPos(axis, line);
    const before = this.drawnCards();
    const kept = this.snapshot();
    const holds = () => !this.belowMinimum(before);
    const moved = this.grid.moveBoundary(axis, line, px, allowSnap);
    if (holds()) return moved;
    // The drawn sizes change monotonically along the move, so the last position that keeps them is found by halving the distance between
    // the start, which keeps them, and the refused position, as the mygo workbench finds it.
    let good = from, bad = moved;
    for (let i = 0; i < 40; i++) {
      const middle = (good + bad) / 2;
      this.restore(kept);
      this.grid.moveBoundary(axis, line, middle, false);
      if (holds()) good = middle;
      else bad = middle;
    }
    this.restore(kept);
    return this.grid.moveBoundary(axis, line, good, false);
  }

  /**
   * The balance of the grid (docs/spec/groups.md#card-commands-on-a-group-card): every child of every cut takes an equal share, with
   * each group card as a box of the layout library (even); in a space without groups, arrange runs the even arrangement of the library
   * instead (cardArrange even).
   */
  share(arrange) {
    if (this.groups.length === 0 && arrange) {
      if (!this.grid.arrange("even")) throw new Error("the layout cannot balance: no equal grid keeps every card at its minimum size");
      // The even arrangement can add an empty card, and lastCard stays the largest issued card number (docs/spec/groups.md#storage).
      for (const card of this.grid.cards) {
        const n = cardNumber(card.id);
        if (n !== null) this.last = Math.max(this.last, n);
      }
      return;
    }
    // The frames follow the tree first, so the drawn rectangles that the balance measures are the ones that the space draws after it.
    this.reframe();
    // Each group card is a box of the layout library with its header above its members, so no cut crosses a group card.
    const box = (node) => ({
      id: node.card,
      head: this.headStep(),
      members: node.members.map((member) => (typeof member === "string" ? member : box(member))),
    });
    try {
      this.grid.even(this.groups.map(box));
    } catch (error) {
      throw new Error(`the layout cannot balance: ${error.message}`);
    }
  }

  /**
   * Balances the grid with share, arrange as there, and keeps the result only when no content card that it changed is drawn below its
   * minimum (docs/spec/groups.md#card-commands-on-a-group-card).
   */
  balance(arrange = false) {
    const before = this.drawnCards();
    const kept = this.snapshot();
    try {
      this.share(arrange);
    } catch (error) {
      this.restore(kept);
      throw error;
    }
    const below = this.belowMinimum(before);
    if (below) {
      this.restore(kept);
      throw new Error(`the layout cannot balance: ${this.minimumText(below)}`);
    }
  }

  /**
   * The kept answer of key for the current layout, or the answer of ask, which it keeps: the head buttons ask canSplit, canGroup and
   * canClose for every head in each draw, and a draw without a layout change runs no trial operation.
   */
  answer(key, ask) {
    const token = this.layoutToken();
    if (token !== this.answersToken) {
      this.answers = new Map();
      this.answersToken = token;
    }
    if (this.answers.has(key)) return this.answers.get(key);
    const answer = ask();
    // An answer asked inside the trial operation describes the layout of that trial and replaced the kept answers.
    if (this.answersToken !== token) {
      this.answers = new Map();
      this.answersToken = token;
    }
    this.answers.set(key, answer);
    return answer;
  }

  /**
   * Everything that an answer of canSplit, canGroup or canClose reads: the arrangement of the grid with its paidBy records, the size,
   * gap, smallest edge and fill order of the plane, the head height and the group cards with their members.
   */
  layoutToken() {
    const { grid } = this;
    return JSON.stringify([grid.toJSON(), grid.width, grid.height, grid.gap, grid.minSize, grid.fillOrder, this.options, this.groups]);
  }

  /** Runs change and puts everything back, and returns what change returned or throws what it threw. */
  probe(change) {
    this.probes += 1;
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
   * the half toward side after the other cards of the grid, and the content cards inside the node are laid into the other half; the cards
   * outside keep their lines.
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
    const other = x ? { y0: state.ys[box.r0], y1: state.ys[box.r1] } : { x0: state.xs[box.c0], x1: state.xs[box.c1] };
    // The new card follows the other cards of the grid, as a split of the library appends its card.
    placed.push({ card: { id, fixed: false, data }, ...other, [lo]: born[0], [hi]: born[1] });
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

  /** Finds the card id of the space, or refuses it. */
  require(id) {
    const found = this.find(id);
    if (!found) throw new Error(`no card ${id}`);
    return found;
  }

  /**
   * Groups the card id, a content card or a group card, with a new content card with data toward side and returns {group, card}, the
   * group card and the new card (docs/spec/groups.md#commands).
   */
  create(id, side, data) {
    if (isPlace(id)) throw new Error(`card ${id} is a window sidebar; a group holds content cards and group cards`);
    if (!SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
    const found = this.require(id);
    return this.attempt(id, `hold a group toward ${side}`, () => {
      const group = this.issue();
      const born = this.issue();
      if (!this.splitCard(id, side, born, data, true)) throw new Error(`card ${id} cannot hold a group toward ${side}: ${this.noRoomText(id, side)}`);
      const parent = this.parentOf(id);
      const node = { card: group, name: this.nextGroupName(), leader: id, members: [found.node ?? id, born] };
      this.replaceMember(parent, id, node);
      if (this.leaderOf(parent) === id) this.setLeaderOf(parent, group);
      this.levelSplit(id, side, born);
      return { group, card: born };
    });
  }

  /**
   * Puts a new content card with data beside the card id toward side and returns its id: a split of the library for a content card, which
   * joins the group of the card, and the split of the rectangle for a group card, which joins the level that holds it.
   */
  split(id, side, data) {
    const refusal = () => new Error(`card ${id} cannot split toward ${side}`);
    const found = this.find(id);
    if (!found || isPlace(id) || !SIDES.includes(side)) throw refusal();
    return this.attempt(id, `split toward ${side}`, () => {
      const born = this.issue();
      if (!this.splitCard(id, side, born, data, false)) throw new Error(`card ${id} cannot split toward ${side}: ${this.noRoomText(id, side)}`);
      this.attach(found.parent, born);
      this.leaderEntered(found.parent, born);
      this.levelSplit(id, side, born);
      return born;
    });
  }

  /** Whether split of the card id toward side would succeed. */
  canSplit(id, side) {
    return this.splitRefusal(id, side) === null;
  }

  /** The text with which split of the card id toward side would be refused, or null when it would succeed. */
  splitRefusal(id, side) {
    return this.answer(`split:${id}:${side}`, () => this.probe(() => {
      try {
        this.split(id, side, undefined);
        return null;
      } catch (error) {
        return error.message;
      }
    }));
  }

  /**
   * Adds a content card with data inside the group card id at the right edge of its rectangle, by the split of the rectangle toward right,
   * and returns its id (docs/spec/groups.md#card-commands-on-a-group-card).
   */
  addCard(id, data) {
    const node = this.requireGroup(id);
    return this.attempt(id, "split toward right", () => {
      const born = this.issue();
      this.splitRectangle(node, "right", born, data);
      node.members.push(born);
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
      this.closeCell(id, "close");
      this.detach(found.parent, id);
      this.leaderLeft(found.parent, id);
      this.collapse();
    });
    return ended;
  }

  /**
   * Splits the card target toward side into the card id with data, with the split of its rectangle for a group card. A split toward top or
   * bottom whose upper card is drawn below headers, which the split of the group button always is (grouping), cuts at a new line
   * (docs/spec/groups.md#splitting). Returns false when the layout refuses.
   */
  splitCard(target, side, id, data, grouping) {
    const node = this.node(target);
    if (node) {
      this.splitRectangle(node, side, id, data);
      return true;
    }
    const newLine = (side === "top" || side === "bottom") && (grouping || this.rect(target).y > this.grid.rect(target).y + EPSILON);
    if (this.grid.splitToward(target, side, { id, data, newLine }) !== null) return true;
    // The library refuses a split whose halves fall below its minimum. The split is made again without the minimum, so the check of
    // attempt names the content card that would be drawn below it and the size it would get (docs/spec/groups.md#commands).
    const min = this.grid.minSize;
    this.grid.minSize = 0;
    try {
      return this.grid.splitToward(target, side, { id, data, newLine }) !== null;
    } finally {
      this.grid.minSize = min;
    }
  }

  /**
   * Moves the line between the card target and the new card id of a split toward top or bottom, so that both are drawn at one height below
   * the headers that the upper one stands under and inside the frames of their level (docs/spec/groups.md#splitting). A split across, and a line that other cards stand on,
   * do not change it, so a split moves no line of another card.
   */
  levelSplit(target, side, id) {
    if (side !== "top" && side !== "bottom") return;
    // The new card takes the frames of its level first, so both drawn heights are the heights that the check of the split reads.
    this.reframe();
    const [upper, lower] = side === "top" ? [id, target] : [target, id];
    const up = this.rect(upper), down = this.rect(lower);
    const inside = (card) => (this.node(card) ? this.contents(this.node(card)) : [card]);
    const lowerNode = this.node(lower);
    const line = lowerNode ? this.rectangle(lowerNode).r0 : this.grid.card(lower).r0;
    const pieces = new Set([...inside(upper), ...inside(lower)]);
    if (this.grid.cards.some((card) => (card.r0 === line || card.r1 === line) && !pieces.has(card.id))) return;
    const delta = (down.h - up.h) / 2;
    if (Math.abs(delta) > EPSILON) this.grid.moveLinePast("y", line, this.grid.boundaryPos("y", line) + delta);
  }

  /**
   * Closes the card id of the grid for the operation text op and returns the fill sides it closed with: a row of neighbours takes its
   * cells, the sides are tried in the fill order of the layout library with the sides whose row lies inside the level of the card first,
   * and the first result that keeps every group card one rectangle is kept; without such a row the slots of the card are removed, as the
   * library removes them (R7), and the sides are empty. A refusal names its cause (docs/spec/groups.md#closing). parent is the group node
   * of the level of the card, or null for the root level; a move passes the level that the card had before it left it.
   */
  closeCell(id, op, parent = this.parentOf(id)) {
    const refused = (why) => new Error(`card ${id} cannot ${op}: ${why}`);
    const card = this.grid.card(id);
    if (!card || card.fixed || this.grid.cards.filter((other) => !other.fixed).length <= 1) throw refused("it is the last card of the layout");
    const level = new Set(this.levelMembers(parent).flatMap((member) => (typeof member === "string" ? [member] : this.contents(member))));
    const inLevel = (side) => this.grid.fill(id, [side])?.cards.every((other) => level.has(other.id)) ?? false;
    const sides = [...this.grid.fillSides].sort((a, b) => Number(inLevel(b)) - Number(inLevel(a)));
    // The group cards in workbench order, read before a close takes a card out of the grid that the reading order measures.
    const groups = this.nodes();
    let broken = null;
    for (const side of sides) {
      if (!this.grid.fill(id, [side])) continue;
      // Only the grid is put back: the nodes of the tree stay the objects that the caller holds.
      const kept = this.snapshot().state;
      if (this.grid.close(id, [side])) {
        const group = groups.find((node) => !this.covers(node));
        if (!group) return [side];
        broken ??= group.card;
      }
      this.grid.replace(kept);
    }
    if (broken !== null) throw refused(`group ${broken} would not cover one rectangle`);
    if (this.grid.close(id, [])) return [];
    throw refused("no row of cards that can grow covers a side of it, and its slots hold other cards");
  }

  /** Whether close of the card id would succeed. */
  canClose(id) {
    return this.answer(`close:${id}`, () => this.probe(() => {
      try {
        this.close(id);
        return true;
      } catch {
        // silent: the probe answers whether the close succeeds; the refusal is the answer false.
        return false;
      }
    }));
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
    const operation = `move to ${side} of ${target}`;
    this.attempt(id, operation, () => {
      const data = found.node ? undefined : this.grid.card(id).data;
      this.detach(found.parent, id);
      this.leaderLeft(found.parent, id);
      if (side === "centre") {
        const into = this.node(target);
        const merged = found.node ? this.merge(found.node) : null;
        this.closeCell(id, operation, found.parent);
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
      if (beside || found.node) {
        // A group card made one card, or any card beside a group card, closes and is split in beside its target, as the split of the
        // target lays it.
        this.closeCell(id, operation, found.parent);
        if (!this.splitCard(landing, side, id, data, false)) throw refusal();
      } else {
        // The move closes the card with the sides that closeCell chose on the same state, then lands it beside landing.
        const kept = this.snapshot().state;
        const sides = this.closeCell(id, operation, found.parent);
        this.grid.replace(kept);
        if (!this.grid.move(id, landing, side, sides)) throw refusal();
      }
      if (merged) this.unmerge(found.node, merged);
      const parent = this.parentOf(landing);
      this.attach(parent, found.node ?? id);
      this.leaderEntered(parent, id);
    });
  }

  /** Whether move of the card id to side of target would succeed. */
  canMove(id, target, side) {
    return this.probe(() => {
      try {
        this.move(id, target, side);
        return true;
      } catch {
        // silent: the probe answers whether the move succeeds; the refusal is the answer false.
        return false;
      }
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
   * Resolves a drop at x, y on the innermost box that holds the point (docs/spec/groups.md#moving-and-dropping) and returns {card, zone} or
   * null: a content card whose drawn rectangle holds the point gives the zone of zoneAt of the grid; otherwise the innermost group card
   * whose frame holds it gives its own zones, the centre on its header and in its middle and a side in the outer edge fraction of its
   * frame; a point in no box is no zone. options are the headerPx and edge of zoneAt and without, a dragged group card that the resolution
   * leaves out with the cards inside it.
   */
  dropAt(x, y, options) {
    const { without = null, ...zone } = options;
    // default: edge is an optional option of zoneAt, documented as 0.25.
    const edge = zone.edge ?? 0.25;
    // The dragged group card and the cards inside it are no target.
    const excluded = (id) => without !== null && (id === without || (this.find(id)?.path ?? []).some((node) => node.card === without));
    const holds = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    let hit = null;
    let frame = null;
    for (const { id, node } of this.order()) {
      const r = this.rect(id);
      if (!holds(r)) continue;
      if (!node) {
        if (excluded(id)) return null;
        const found = this.grid.zoneAt(x, y, zone);
        return found && { card: found.id, zone: found.zone };
      }
      // The innermost frame that holds the point is the smallest one.
      if (hit === null || r.w * r.h < frame.w * frame.h) {
        hit = id;
        frame = r;
      }
    }
    if (hit === null || excluded(hit)) return null;
    const head = this.headRect(hit);
    if (y <= head.y + head.h) return { card: hit, zone: "centre" };
    const px = (x - frame.x) / frame.w;
    const py = (y - frame.y) / frame.h;
    if (px > edge && px < 1 - edge && py > edge && py < 1 - edge) return { card: hit, zone: "centre" };
    const nearest = Math.min(px, 1 - px, py, 1 - py);
    return { card: hit, zone: nearest === px ? "left" : nearest === 1 - px ? "right" : nearest === py ? "top" : "bottom" };
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
  if (nodes.length) {
    // default: paidBy is an optional member of a grid state.
    const [paid] = Object.keys(state.paidBy ?? {}).sort();
    if (paid !== undefined) throw new Error(`layout with groups stores the paidBy record of card ${paid}; a layout with groups keeps none`);
    for (const [axis, lines, lo, hi] of [["x", state.xs, "c0", "c1"], ["y", state.ys, "r0", "r1"]]) {
      const used = new Set(state.cards.flatMap((card) => [card[lo], card[hi]]));
      const unused = lines.findIndex((_, k) => !used.has(k));
      if (unused >= 0) throw new Error(`layout with groups stores the ${axis} line ${unused}, which no card uses; a layout with groups keeps none`);
    }
    const breach = tree.formBreach();
    if (breach?.groups) {
      throw new Error(`layout with groups stores the groups ${breach.groups[0]} and ${breach.groups[1]}, which overlap; two groups are disjoint or one holds the other`);
    }
    if (breach) {
      throw new Error(`layout with groups stores the ${breach.axis} lines ${breach.line} and ${breach.line + 1} at one coordinate; a layout with groups keeps none`);
    }
  }
  const refused = new Error(`layout stores lastCard ${JSON.stringify(lastCard) ?? "undefined"}, which is not the largest issued card number`);
  if (!Number.isInteger(lastCard) || lastCard < 1 || lastCard > LAST_LIMIT) throw refused;
  for (const id of [...cards, ...seen]) {
    const n = cardNumber(id);
    if (n !== null && n > lastCard) throw refused;
  }
  tree.last = lastCard;
  tree.reframe();
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
