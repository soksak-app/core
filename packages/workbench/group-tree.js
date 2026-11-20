// The group tree of a space (docs/spec/groups.md#model): one grid of the layout library, whose boxes are the group cards with the data
// {name, leader}, and beside it the record of the levels that those boxes make. The tree holds the leader of each level and the card
// numbers that the space issued; it draws the headers of the group cards inside the top of their boxes, acts on a group card with the
// operations of the library on its box, and refuses an operation that draws a content card below its minimum
// (docs/spec/groups.md#minimum-size). The Go layout model of packages/workbench-mygo passes the same shared cases,
// docs/spec/cases/layout/groups.json.
import { checkState } from "soksak";
import { isPlace } from "./registry.js";

/** The sides of a split, a group and a move beside a card. */
const SIDES = ["left", "right", "top", "bottom"];

/** Whether a node of the stored tree is a card, a box or a cut. */
const isCardNode = (n) => typeof n.card === "string";
const isBoxNode = (n) => typeof n.box === "string";
const isCutNode = (n) => n.cut === "x" || n.cut === "y";

/** The id of a card or a box node. */
const nodeKey = (n) => (isBoxNode(n) ? n.box : n.card);

/** The cards and boxes of the node n, the kids of its cuts in their order without the inside of a box. */
const nodeMembers = (n) => (isCutNode(n) ? n.kids.flatMap((kid) => nodeMembers(kid.node)) : [nodeKey(n)]);

/** The box id in the node n, or null. */
function boxIn(n, id) {
  if (isBoxNode(n)) return n.box === id ? n : boxIn(n.inner, id);
  if (isCutNode(n)) for (const kid of n.kids) {
    const found = boxIn(kid.node, id);
    if (found) return found;
  }
  return null;
}

/** A target of a drop or a move as the commands write it: one id as that id, more ids as their list. */
const targetText = (ids) => (ids.length === 1 ? ids[0] : ids);

/** The ids of a target that names one id or a list of ids. */
export const targetIds = (target) => (typeof target === "string" ? [target] : target);

/** The axis of a side and the sides at the start and at the end of an axis. */
const axisOf = (side) => (side === "left" || side === "right" ? "x" : "y");
const nearSide = (axis) => (axis === "y" ? "top" : "left");
const farSide = (axis) => (axis === "y" ? "bottom" : "right");

/** The coordinate of the side of a rectangle. */
const edgeOf = (r, side) => (side === "left" ? r.x : side === "right" ? r.x + r.w : side === "top" ? r.y : r.y + r.h);

/**
 * The side stack of side in chain: its innermost link and each link above it that ends on the same screen line toward side, from the
 * outermost in: the box of a node, a cut whose kid toward side is the node below it, and a cut across the axis of side.
 */
function sideStack(chain, side) {
  const axis = axisOf(side), after = side === "right" || side === "bottom";
  const stack = [chain[chain.length - 1]];
  for (let j = chain.length - 1; j > 0; j--) {
    const link = chain[j], holder = chain[j - 1];
    const shares = link.at < 0 || holder.node.cut !== axis || (after && link.at === holder.node.kids.length - 1) || (!after && link.at === 0);
    if (!shares) break;
    stack.unshift(holder);
  }
  return stack;
}

/**
 * The kid of the cut across the axis of side that holds the node of the band at the link at of stack, through the cuts along the axis of
 * side, which give no band: {cut, kid}, the members of that cut joined by a space and the index of the kid, or the cut null when a box or
 * the root comes first.
 */
function kidOf(stack, at, side) {
  for (let j = at; j > 0 && stack[j].at >= 0; j--) {
    const holder = stack[j - 1].node;
    if (holder.cut !== axisOf(side)) return { cut: nodeMembers(holder).join(" "), kid: stack[j].at };
  }
  return { cut: null, kid: 0 };
}

/**
 * The target of a link of a side stack as a list of ids, or null: a card that is no window sidebar and not fixed, a box, a cut across the
 * axis of side that holds no window sidebar, and the root cut that holds one as the content of the plane. A cut along the axis of side
 * has the result of its kid toward side, so it gives no band of its own.
 */
function stackTarget(link, side) {
  const n = link.node;
  if (isCardNode(n)) return n.fixed || isPlace(n.card) ? null : [n.card];
  if (isBoxNode(n)) return [n.box];
  if (n.cut === axisOf(side)) return null;
  const ids = nodeMembers(n);
  if (!ids.some(isPlace)) return ids;
  return link.holder === null ? ids.filter((id) => !isPlace(id)) : null;
}

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

/** How far a line that stands beside a header may reach into it across the line, in px: a divider at the side of a group card touches the
 * end of its header by less than this. A line inside the width of a header, a rule of one px among them, crosses the header however thin
 * it is. */
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
    const inside = a0 >= h0 && a1 <= h1;
    if (!inside && Math.min(a1, h1) - Math.max(a0, h0) <= HEAD_TOLERANCE) continue;
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

  /** The cards of the grid inside a group node; a card that an operation in progress took out of the grid is left out. */
  held(node) {
    return this.contents(node).map((id) => this.grid.card(id)).filter(Boolean);
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
   * Every group node of the tree in workbench order.
   */
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

  /** Sets the leader of the level of parent; the leader of a group card is in the data of its box. */
  setLeaderOf(parent, id) {
    if (!parent) {
      this.rootLeader = id;
      return;
    }
    parent.leader = id;
    this.grid.setData(parent.card, { name: parent.name, leader: id });
  }

  /**
   * The drawn rectangle {x, y, w, h} of the card id (docs/spec/groups.md#drawn-rectangles), or undefined for no card of the space: the
   * rectangle of the card or the box in the grid, which the frames of the boxes around it inset, moved down and shortened by the heads
   * that the grid draws inside the top of it, the headers of the group cards that hold it and start on its first row line.
   */
  rect(id) {
    if (!this.find(id)) return undefined;
    const r = this.grid.rect(id);
    const heads = this.grid.headsAbove(id);
    return { x: r.x, y: r.y + heads, w: r.w, h: Math.max(0, r.h - heads) };
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
   * and the frames (R5), and none at the seam, where a frame takes no gap: read off a group card drawn with a size on axis, as the
   * distance between the edge of its first content card and the edge of the same span without frames, over the group cards that hold that
   * card and start on that line; 0 when no such card stands.
   */
  frameUnit(axis) {
    if (this.options.seam) return 0;
    for (const node of this.nodes()) {
      const span = this.rectangle(node);
      const card = this.held(node).find((one) => (axis === "x" ? one.c0 === span.c0 : one.r1 === span.r1));
      const drawn = card && this.grid.rect(card.id);
      if (!drawn || (axis === "x" ? drawn.w : drawn.h) <= 0) continue;
      const bare = this.grid.rectOf({ ...card, id: "" });
      const path = this.find(card.id).path;
      const count = path.filter((holder) => (axis === "x" ? this.rectangle(holder).c0 === card.c0 : this.rectangle(holder).r1 === card.r1)).length;
      return axis === "x" ? (drawn.x - bare.x) / count : (bare.y + bare.h - drawn.y - drawn.h) / count;
    }
    return 0;
  }

  /**
   * Gives the grid the head of every group card (docs/spec/groups.md#drawn-rectangles): the header of a group card and the corridor below
   * it, which the library counts inside the top of its box. The library derives the frames from the boxes of the tree: one corridor on each
   * side but the top, and none at the seam (frames none), where the corridor is the one border line that two boxes share. A copy of the
   * grid takes the same frames and heads through grid.
   */
  reframe(grid = this.grid) {
    grid.frames = this.options.seam ? "none" : "corridor";
    grid.setHeads(Object.fromEntries(this.nodes().map((node) => [node.card, this.headStep()])));
  }

  /**
   * The frames of the content card id (docs/spec/groups.md#drawn-rectangles): on its left, right and bottom side the number of group
   * cards that hold it and end on the line of that side, which the layout library draws from the boxes of the tree. The top takes no
   * frame, because the header of a group card stands inside its frame at the top; at the seam, where a frame takes no gap, no card has a
   * frame.
   */
  framesOf(id) {
    const counts = { left: 0, right: 0, top: 0, bottom: 0 };
    if (this.options.seam) return counts;
    const card = this.grid.card(id);
    // default: a card that the walk does not meet holds no group.
    for (const node of this.find(id)?.path ?? []) {
      const span = this.rectangle(node);
      if (span.c0 === card.c0) counts.left++;
      if (span.c1 === card.c1) counts.right++;
      if (span.r1 === card.r1) counts.bottom++;
    }
    return counts;
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
    return { state: this.grid.toJSON(), groups: structuredClone(this.groups), rootLeader: this.rootLeader, last: this.last };
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

  /** The text of a content card drawn below its minimum. */
  minimumText(card) {
    const { minSize } = this.options;
    return `card ${card.id} would be ${sizeText(card.rect.w, card.rect.h)}, below its minimum ${sizeText(minSize, minSize)}`;
  }

  /**
   * Runs change on the grid and the tree and keeps its result only when no content card that it changed is drawn below its minimum; otherwise everything is put back and the refusal of the card id and the operation text is thrown
   * (docs/spec/groups.md#commands). The error that change throws is thrown after the state is put back.
   */
  attempt(id, operation, change) {
    const before = this.drawnCards();
    const kept = this.snapshot();
    let result;
    try {
      result = change();
      this.reframe();
      const below = this.belowMinimum(before);
      if (below) throw new Error(`card ${id} cannot ${operation}: ${this.minimumText(below)}`);
    } catch (error) {
      this.restore(kept);
      throw error;
    }
    return result;
  }

  /**
   * Moves the boundary line of axis toward px, as moveBoundary of the grid does across every group, and stops at the last position at
   * which every content card that the move changes is drawn at least minSize (docs/spec/groups.md#minimum-size). In a space with groups a
   * line that ends on the coordinate of another line merges onto it, as at the end of a drag. Returns where the boundary stands.
   */
  moveBoundary(axis, line, px, allowSnap) {
    return this.placeBoundary(axis, line, px, allowSnap);
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
    // Each group card is a box of the tree with its header inside the top of its box, so a group card is one kid of its cut.
    try {
      this.grid.even();
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
   * Everything that an answer of canSplit, canGroup or canClose reads: the tree of the grid, the size, gap and smallest edge of the plane,
   * the head height and the seam, and the group cards with their members.
   */
  layoutToken() {
    const { grid } = this;
    return JSON.stringify([grid.toJSON(), grid.width, grid.height, grid.gap, grid.minSize, this.options, this.groups]);
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

  /**
   * Replaces each group card that holds one member with that member, which takes its place and its leader mark, and its box gives its
   * place to the member by unwrap of the library (docs/spec/groups.md#closing).
   */
  collapse() {
    for (let single = this.nodes().find((node) => node.members.length === 1); single; single = this.nodes().find((node) => node.members.length === 1)) {
      const parent = this.parentOf(single.card);
      const [only] = single.members;
      const members = parent ? parent.members : this.groups;
      const at = members.indexOf(single);
      if (typeof only === "string" && !parent) members.splice(at, 1);
      else members.splice(at, 1, only);
      if (this.leaderOf(parent) === single.card) this.setLeaderOf(parent, memberId(only));
      this.grid.unwrap(single.card);
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
   * group card and the new card (docs/spec/groups.md#commands).
   */
  create(id, side, data) {
    if (isPlace(id)) throw new Error(`card ${id} is a window sidebar; a group holds content cards and group cards`);
    if (!SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
    const found = this.require(id);
    return this.attempt(id, `hold a group toward ${side}`, () => {
      const name = this.nextGroupName();
      const group = this.issue();
      const born = this.issue();
      // The group split is one operation of the layout, judged on the box with its head (docs/spec/groups.md#commands).
      const card = data === undefined ? { card: born } : { card: born, data };
      try {
        this.grid.group(id, side, card, { box: group, data: { name, leader: id }, head: this.headStep() });
      } catch (error) {
        throw new Error(`card ${id} cannot hold a group toward ${side}: ${error.message}`);
      }
      const parent = this.parentOf(id);
      const node = { card: group, name, leader: id, members: [found.node ?? id, born] };
      this.replaceMember(parent, id, node);
      if (this.leaderOf(parent) === id) this.setLeaderOf(parent, group);
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
      this.splitCard(id, side, born, data);
      this.attach(found.parent, born);
      this.leaderEntered(found.parent, born);
      this.levelSplit(id, side, born);
      return born;
    });
  }

  /**
   * Puts a new content card with data beside target toward side and returns its id: the split of one card, or the insert of the layout
   * library beside the cut or the run of neighbouring kids that the ids name, whose new card joins the level of those kids
   * (docs/spec/groups.md#moving-and-dropping).
   */
  splitBeside(target, side, data) {
    const ids = targetIds(target);
    if (ids.length === 1) return this.split(ids[0], side, data);
    if (!SIDES.includes(side)) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
    if (!ids.length) throw new Error("a split names no card");
    for (const id of ids) this.require(id);
    const names = ids.join(", ");
    const parent = this.parentOf(ids[0]);
    return this.attempt(ids[0], `split toward ${side}`, () => {
      const born = this.issue();
      try {
        this.grid.insert(ids, side, data === undefined ? { card: born } : { card: born, data });
      } catch (error) {
        throw new Error(`cards ${names} cannot split toward ${side}: ${error.message}`);
      }
      this.attach(parent, born);
      this.leaderEntered(parent, born);
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
      // The new card stands beside the members of the box toward right, added to the inner node of the box as insert adds a card, so the
      // tree of the members stays.
      this.insert(id, "split toward right", node.members.map(memberId), "right", data === undefined ? { card: born } : { card: born, data });
      node.members.push(born);
      return born;
    });
  }

  /**
   * Closes the card id with every card inside it and returns the content cards that ended, in workbench order. A group card closes as
   * its box with the close of the library (R7); a group card left with one member is replaced by it.
   */
  close(id) {
    const refusal = () => new Error(`card ${id} cannot close`);
    const found = this.find(id);
    if (!found) throw refusal();
    const ended = found.node ? this.order().filter(({ id: card, node }) => !node && this.contents(found.node).includes(card)).map(({ id: card }) => card) : [id];
    this.attempt(id, "close", () => {
      // A group card leaves as its box with every card inside it, so the tree around it stays as it is.
      if (found.node) {
        if (!this.grid.close(id)) throw new Error(`card ${id} cannot close: no kid of its cut can grow`);
      } else this.closeCell(id, "close");
      this.detach(found.parent, id);
      this.leaderLeft(found.parent, id);
      this.collapse();
    });
    return ended;
  }

  /**
   * Puts the new card id with data beside the card target toward side: the split of the layout for a content card, or for a group card
   * the insert of the card beside its box. A split toward top or bottom whose upper card is drawn below headers cuts at a new line
   * (docs/spec/groups.md#splitting). The refusal of the layout, which names the deepest node that the split would draw below its minimum,
   * is the refusal of the operation.
   */
  splitCard(target, side, id, data) {
    const card = data === undefined ? { card: id } : { card: id, data };
    if (this.node(target)) {
      this.insert(target, `split toward ${side}`, target, side, card);
      return;
    }
    const newLine = (side === "top" || side === "bottom") && this.grid.headsAbove(target) > 0;
    try {
      this.grid.splitToward(target, side, { id, data, newLine });
    } catch (error) {
      throw new Error(`card ${target} cannot split toward ${side}: ${error.message}`);
    }
  }

  /** Insert of the grid inside the operation op of the card id: its refusal, which names the deepest node that the insert would draw below its minimum, is the refusal of the operation. */
  insert(id, op, target, side, node) {
    try {
      this.grid.insert(target, side, node);
    } catch (error) {
      throw new Error(`card ${id} cannot ${op}: ${error.message}`);
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
    if (Math.abs(delta) > EPSILON) this.grid.moveBoundary("y", line, this.grid.boundaryPos("y", line) + delta, false);
  }

  /**
   * Closes the card id of the grid for the operation text op: its node, the card or the box around it that holds nothing else, leaves its
   * cut, and the other kids of the cut that are no fixed card take its share by one factor (R7). A refusal names its cause
   * (docs/spec/groups.md#closing).
   */
  closeCell(id, op) {
    const refused = (why) => new Error(`card ${id} cannot ${op}: ${why}`);
    const card = this.grid.card(id);
    if (!card || card.fixed || this.grid.cards.filter((other) => !other.fixed).length <= 1) throw refused("it is the last card of the layout");
    if (!this.grid.close(id)) throw refused("no kid of its cut can grow");
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

  /**
   * Replaces the group card id with its members in the level that holds it: its box gives its place to its inner node by unwrap of the
   * library, and the cards keep their drawn sizes.
   */
  dissolve(id) {
    const node = this.requireGroup(id);
    const parent = this.parentOf(id);
    const members = parent ? parent.members : this.groups;
    const kept = parent ? node.members : node.members.filter((member) => typeof member !== "string");
    members.splice(members.indexOf(node), 1, ...kept);
    if (this.leaderOf(parent) === id) this.setLeaderOf(parent, node.leader);
    this.grid.unwrap(id);
    this.reframe();
  }

  /** Sets the name of the group card id to name with the white space at both ends removed, and returns the name. */
  rename(id, name) {
    const node = this.requireGroup(id);
    const trimmed = name.trim();
    const count = [...trimmed].length;
    if (count < 1 || count > 40) throw new Error(`group name must be 1 to 40 characters: ${trimmed}`);
    node.name = trimmed;
    this.grid.setData(id, { name: trimmed, leader: node.leader });
    return trimmed;
  }

  /** Makes the card id the leader of its level and returns the group card of that level, or null for the root level. */
  setLeader(id) {
    if (isPlace(id)) throw new Error(`card ${id} is a window sidebar and cannot lead a level`);
    const { parent } = this.require(id);
    this.setLeaderOf(parent, id);
    return parent ? parent.card : null;
  }

  /**
   * The refusal of a move of the card id to side of target, one id or the ids of the kids of a cut, or null
   * (docs/spec/groups.md#commands).
   */
  checkMove(id, target, side) {
    if (isPlace(id)) return new Error(`card ${id} is a window sidebar and does not move`);
    const ids = targetIds(target);
    if (!ids.length) return new Error(`card ${id} cannot move beside no card`);
    const placed = ids.find(isPlace);
    if (placed !== undefined) return new Error(`card ${placed} is a window sidebar; a card does not move beside it`);
    const inside = (card) => card === id || (this.find(card)?.path ?? []).some((node) => node.card === id);
    // The card itself names its vacated slot, which is no change; a target inside it is refused (docs/spec/groups.md#vacated-slot).
    const itself = ids.length === 1 && ids[0] === id && side !== "strip";
    if (!itself && ids.every(inside)) return new Error(`card ${id} cannot move into itself`);
    if ((side === "centre" || side === "strip") && ids.length > 1) return new Error(`card ${id} moves to the ${side} of one card, not of ${ids.join(", ")}`);
    if (side === "strip" && this.isGroup(id)) return new Error(`card ${id} is a group and holds no tabs`);
    if (side === "strip" && this.isGroup(ids[0])) return new Error(`card ${ids[0]} is a group and has no tab strip`);
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

  /**
   * Whether the card id already stands where a move to side of target puts it (docs/spec/groups.md#idempotency): target and side name its
   * vacated slot (docs/spec/groups.md#vacated-slot), or it is the neighbour of target toward side in the level of target, or with centre
   * the member of the group card target at the right edge of its rectangle.
   */
  moved(id, at, side) {
    const found = this.find(id);
    const ids = targetIds(at);
    if (found && this.grid.vacates(id, ids, side)) return true;
    if (!found || ids.length !== 1) return false;
    const [target] = ids;
    if (side === "centre") {
      if (found.parent?.card !== target) return false;
      const box = this.box(found.node ?? id);
      const outer = this.rectangle(found.parent);
      return box.c1 === outer.c1 && box.r0 === outer.r0 && box.r1 === outer.r1;
    }
    return this.parentOf(target) === found.parent && this.neighbour(target, side) === id;
  }

  /**
   * Moves the card id, a content card or a group card, beside target on side into the level of target, with side centre into the group
   * card target at the right edge of its rectangle, or with side centre and a content card target into the place of target, which takes
   * the place of id (docs/spec/groups.md#commands). target is one id or the ids of the kids of a cut. The card keeps its id. Returns
   * false when the card already stands where the move puts it, which changes nothing, and true after a move.
   */
  move(id, target, side) {
    const refused = this.checkMove(id, target, side);
    if (refused) throw refused;
    const names = targetIds(target).join(", ");
    const refusal = () => new Error(`card ${id} cannot move to ${side} of ${names}`);
    if (side !== "centre" && !SIDES.includes(side)) throw refusal();
    const found = this.find(id);
    if (!found || !targetIds(target).every((card) => this.find(card))) throw refusal();
    // A move that names the vacated slot or the place where the card stands is no change, before an exchange with a content card.
    if (this.moved(id, target, side)) return false;
    if (side === "centre" && !this.isGroup(targetIds(target)[0])) {
      this.exchange(id, targetIds(target)[0]);
      return true;
    }
    const operation = `move to ${side} of ${names}`;
    // The target is the node after the withdraw of the moving card (docs/spec/groups.md#target-search): a cut or a run that holds the
    // moving card names the kids that remain.
    const ids = targetIds(target).filter((card) => card !== id && !(this.find(card)?.path ?? []).some((node) => node.card === id));
    this.attempt(id, operation, () => {
      const moving = found.node ?? id;
      // A move is a withdraw and an insert: the card or the box of the group card leaves its cut, whose other kids take its space in
      // proportion, and lands beside the target, or with centre at the right edge of the tree of the group card target
      // (docs/spec/groups.md#closing).
      let left;
      try {
        left = this.grid.withdraw(id);
      } catch (error) {
        throw new Error(`card ${id} cannot ${operation}: ${error.message}`);
      }
      // The card leaves the group tree before the insert, so the insert measures every card with the heads that it is drawn with.
      this.detach(found.parent, id);
      this.reframe();
      const into = side === "centre" ? this.node(ids[0]) : this.parentOf(ids[0]);
      const at = side === "centre" ? into.members.map(memberId).filter((member) => member !== id) : ids;
      this.insert(id, operation, at, side === "centre" ? "right" : side, left);
      // The group that the card leaves is replaced by its one member after the insert, so a move beside that group lands beside it and
      // the member takes its place.
      this.attach(into, moving);
      // The leader rule reads the members of the levels after the card stands in its new level: a card that moves inside its own level
      // does not leave it and keeps its leader mark, and the first remaining member of a level that the card left leads it
      // (docs/spec/groups.md#leader).
      if (into !== found.parent) this.leaderLeft(found.parent, id);
      this.leaderEntered(into, id);
      this.collapse();
    });
    return true;
  }

  /**
   * Puts the card id, a content card or a group card, where the content card other stands and other where id stood, by exchange of the
   * grid: each place keeps its size and the leader mark of its level (docs/spec/groups.md#commands).
   */
  exchange(id, other) {
    if (!this.find(id)) throw new Error(`card ${id} cannot move to centre of ${other}`);
    this.attempt(id, `move to centre of ${other}`, () => {
      try {
        this.grid.exchange(id, other);
      } catch (error) {
        throw new Error(`card ${id} cannot move to centre of ${other}: ${error.message}`);
      }
      const a = this.find(id), b = this.find(other);
      const la = this.leaderOf(a.parent), lb = this.leaderOf(b.parent);
      const ma = a.node ?? id, mb = b.node ?? other;
      if (a.parent !== b.parent) {
        this.putMember(a.parent, id, mb);
        this.putMember(b.parent, other, ma);
      }
      // The leader mark stays with its place.
      if (a.parent === b.parent) {
        if (la === id) this.setLeaderOf(a.parent, other);
        else if (la === other) this.setLeaderOf(a.parent, id);
        return;
      }
      if (la === id) this.setLeaderOf(a.parent, other);
      if (lb === other) this.setLeaderOf(b.parent, id);
    });
  }

  /**
   * Records member in the level of parent in place of the member id, or takes the record of id out when member is a content card of the
   * root level, which is held by no node; a member that enters the place of an unrecorded content card of the root level is recorded.
   */
  putMember(parent, id, member) {
    const members = parent ? parent.members : this.groups;
    const at = members.findIndex((entry) => memberId(entry) === id);
    const record = parent !== null || typeof member !== "string";
    if (at >= 0 && record) members.splice(at, 1, member);
    else if (at >= 0) members.splice(at, 1);
    else if (record) members.push(member);
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
   * The drawn rectangle of the node n of the stored tree: of a card or a box its drawn rectangle, of a cut the smallest rectangle that
   * holds the drawn rectangles of its kids.
   */
  drawnRect(n) {
    if (!isCutNode(n)) return this.rect(nodeKey(n));
    return n.kids.map((kid) => this.drawnRect(kid.node)).reduce((out, r) => {
      const x0 = Math.min(out.x, r.x), y0 = Math.min(out.y, r.y);
      const x1 = Math.max(out.x + out.w, r.x + r.w), y1 = Math.max(out.y + out.h, r.y + r.h);
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    });
  }

  /**
   * The chain of the point x, y: the nodes of the stored tree that hold it, from the root to the innermost card, through the inner node of
   * each box, each as {node, holder, at, rect} with the cut that holds it and its index there (-1 for the inner node of a box). The kids of
   * a cut divide its extent at the middle of each corridor between their drawn rectangles, so every point of the plane lies in one kid.
   */
  chain(root, x, y) {
    const out = [{ node: root, holder: null, at: -1, rect: this.drawnRect(root) }];
    for (let cur = root; ;) {
      if (isBoxNode(cur)) {
        out.push({ node: cur.inner, holder: cur, at: -1, rect: this.drawnRect(cur.inner) });
        cur = cur.inner;
      } else if (isCutNode(cur)) {
        const p = cur.cut === "y" ? y : x;
        const rects = cur.kids.map((kid) => this.drawnRect(kid.node));
        let at = cur.kids.length - 1;
        for (let i = 0; i < cur.kids.length - 1; i++) {
          if (p < (edgeOf(rects[i], farSide(cur.cut)) + edgeOf(rects[i + 1], nearSide(cur.cut))) / 2) {
            at = i;
            break;
          }
        }
        out.push({ node: cur.kids[at].node, holder: cur, at, rect: rects[at] });
        cur = cur.kids[at].node;
      } else {
        return out;
      }
    }
  }

  /**
   * The distance of the point x, y inside the line toward side; from a top line it leaves out the tab strips of the height strip and the
   * group headers between the line and the point, which are targets of their own.
   */
  within(side, line, x, y, strip) {
    let dist = side === "left" ? x - line : side === "right" ? line - x : side === "top" ? y - line : line - y;
    if (side === "top") {
      for (const { id, node } of this.order()) {
        const r = this.rect(id);
        if (isPlace(id) || x < r.x || x > r.x + r.w) continue;
        const high = node ? this.options.head : strip;
        const a = Math.max(line, r.y), b = Math.min(y, r.y + high);
        if (b > a) dist -= b - a;
      }
    }
    return Math.max(0, dist);
  }

  /**
   * Resolves a drop at x, y by the target search of the rule of sizes (docs/spec/groups.md#target-search) and returns
   * {kind: "add", target, side, band, of} for the add of the moving card beside target toward side, target one id or the ids of the kids
   * of a cut, band the index of the band from the outermost and of the number of bands on its line, or {kind: "strip" | "centre", card} for
   * the tab strip and the centre of a content card, or null for a point on a window sidebar or in no card or box. options are headerPx,
   * the height of the tab strip of a content card, edge, the edge share of the body of a card, band, the standard width of a band, and
   * bandMargin, the margin that the bands of a side keep before the centre of the card. options.group is set for a dragged group card,
   * which holds cards and no tabs, so a tab strip is no target of it and is part of the body of its card.
   */
  targetAt(x, y, options) {
    return this.dragAt(null, x, y, options).hit;
  }

  /**
   * Resolves the drop of a drag at x, y whose anchor is anchor, null before the drag enters a line, and returns {hit, anchor}: the target
   * of targetAt and the anchor of the next point, the anchor while the point stays on its band of its line, the band of the point when
   * it enters another, and null off the bands. A band whose node is another kid of the cut of the anchor across the axis of the side is
   * the run of the kids between the two (docs/spec/groups.md#target-search).
   */
  dragAt(anchor, x, y, options) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { hit: null, anchor: null };
    // A group card holds cards and no tabs, so a tab strip is no target of it and is part of the body of its card
    // (docs/spec/groups.md#target-search).
    if (options.group) options = { ...options, headerPx: 0 };
    const holds = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    let content = null, group = null, frame = null;
    for (const { id, node } of this.order()) {
      const r = this.rect(id);
      if (!holds(r)) continue;
      if (!node) content = id;
      else if (group === null || r.w * r.h < frame.w * frame.h) {
        group = id;
        frame = r;
      }
    }
    const root = this.grid.toJSON().root;
    if (content === null && group === null && !holds(this.drawnRect(root))) return { hit: null, anchor: null };
    const body = content === null ? null : this.rect(content);
    const inStrip = content !== null && !isPlace(content) && y < body.y + options.headerPx;
    const inHead = content === null && group !== null && y <= this.headRect(group).y + this.options.head;
    if (!inStrip) {
      const found = this.bandAt(root, x, y, options, inHead ? group : null, content === null && !inHead, anchor);
      if (found) return found;
    }
    return { hit: this.bodyAt(root, x, y, options, content, group, body, inStrip, inHead), anchor: null };
  }

  /** The target of a point in no band: the tab strip, the centre or the outer quarter of a content card, or the header of a group card. */
  bodyAt(root, x, y, options, content, group, body, inStrip, inHead) {
    if (inStrip) return { kind: "strip", card: content };
    if (content !== null && isPlace(content)) return null;
    if (content !== null) {
      const top = body.y + options.headerPx, bottom = body.y + body.h;
      if (bottom <= top || !(body.w > 0)) return { kind: "centre", card: content };
      const px = (x - body.x) / body.w, py = (y - top) / (bottom - top);
      const { edge } = options;
      if (px > edge && px < 1 - edge && py > edge && py < 1 - edge) return { kind: "centre", card: content };
      const nearest = Math.min(px, 1 - px, py, 1 - py);
      const side = nearest === px ? "left" : nearest === 1 - px ? "right" : nearest === py ? "top" : "bottom";
      return { kind: "add", target: content, side, band: 0, of: 0 };
    }
    if (inHead) return { kind: "add", target: targetText(nodeMembers(boxIn(root, group).inner)), side: "right", band: 0, of: 0 };
    return null;
  }

  /**
   * The band of the side of the point whose distance divided by the distance that side has is the smallest, when the point lies in it,
   * or always when anywhere is set, as {hit, anchor} with the anchor of the next point of a drag whose anchor is anchor, or null. On the
   * header of the group card head the chain ends at its box, so the bands are those of its left and its right side
   * (docs/spec/groups.md#target-search).
   */
  bandAt(root, x, y, options, head, anywhere, anchor) {
    let chain = this.chain(root, x, y);
    if (head !== null) chain = chain.slice(0, chain.findIndex((link) => isBoxNode(link.node) && link.node.box === head) + 1);
    const leaf = chain[chain.length - 1];
    const r = leaf.rect;
    const top = isCardNode(leaf.node) && !isPlace(leaf.node.card) ? options.headerPx : 0;
    const cx = r.x + r.w / 2, cy = r.y + top + (r.h - top) / 2;
    let best = null;
    for (const side of head !== null ? ["left", "right"] : SIDES) {
      const stack = sideStack(chain, side);
      const line = edgeOf(stack[0].rect, side);
      const bands = [], links = [];
      stack.forEach((link, j) => {
        const target = stackTarget(link, side);
        if (target !== null) {
          bands.push(target);
          links.push(j);
        }
      });
      if (!bands.length) continue;
      const dist = this.within(side, line, x, y, options.headerPx);
      const have = Math.max(1, this.within(side, line, cx, cy, options.headerPx) - options.bandMargin);
      const width = Math.min(options.band, have / bands.length);
      const score = dist / have;
      if (best === null || score < best.score) best = { side, dist, width, score, line, bands, stack, links };
    }
    if (best === null || !(best.dist < best.bands.length * best.width || anywhere)) return null;
    const at = Math.min(best.bands.length - 1, Math.floor(best.dist / best.width));
    const hit = { kind: "add", target: targetText(best.bands[at]), side: best.side, band: at, of: best.bands.length };
    const { cut, kid } = kidOf(best.stack, best.links[at], best.side);
    if (anchor === null || anchor.side !== best.side || anchor.line !== best.line || anchor.band !== at) {
      return { hit, anchor: { side: best.side, line: best.line, band: at, cut, kid } };
    }
    if (cut !== null && cut === anchor.cut && kid !== anchor.kid) {
      let holder = best.stack[best.links[at]];
      for (let j = best.links[at]; j > 0; j--) {
        if (nodeMembers(best.stack[j - 1].node).join(" ") === cut) {
          holder = best.stack[j - 1];
          break;
        }
      }
      hit.target = targetText(holder.node.kids.slice(Math.min(kid, anchor.kid), Math.max(kid, anchor.kid) + 1).flatMap((k) => nodeMembers(k.node)));
    }
    return { hit, anchor };
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
   * The stored form of the layout (docs/spec/groups.md#storage): {state, leader, lastCard}, the tree of the grid with the group cards as
   * boxes, the leader of the root level or null, and lastCard.
   */
  stored() {
    return { state: this.grid.toJSON(), leader: this.rootLeader, lastCard: this.last };
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
 * Reads the stored layout of a space, {state, leader, lastCard}, the tree of the grid with its group cards as boxes, into grid and
 * returns its group tree; each refusal throws the text of docs/spec/groups.md#storage without the prefix that names the file, the
 * project and the space. groups is the group list of the earlier form, which is refused. A member that is absent is undefined.
 */
export function readGroupTree({ state, groups, leader, lastCard }, options, grid) {
  checkState(state);
  if (groups !== undefined) throw new Error("layout stores groups, the group list of the earlier form; the group cards are boxes of state");
  grid.replace(state);
  const seen = new Set();
  const level = readLevel(state.root, seen);
  const tree = new GroupTree(grid, options, level.filter((member) => typeof member !== "string"), null, 0);
  tree.rootLeader = readLeader("root", level.map(memberId), leader, true);
  const refused = new Error(`layout stores lastCard ${JSON.stringify(lastCard) ?? "undefined"}, which is not the largest issued card number`);
  if (!Number.isInteger(lastCard) || lastCard < 1 || lastCard > LAST_LIMIT) throw refused;
  for (const id of seen) {
    const n = cardNumber(id);
    if (n !== null && n > lastCard) throw refused;
  }
  tree.last = lastCard;
  tree.reframe();
  return tree;
}

/**
 * Reads the members of a level from its node: the cards and the boxes that no box inside it holds, a card as its id and a box as a group
 * node with the members of its inner node. seen collects every id.
 */
function readLevel(node, seen) {
  if (node.cut) return node.kids.flatMap((kid) => readLevel(kid.node, seen));
  if (node.box === undefined) {
    seen.add(node.card);
    return [node.card];
  }
  const id = node.box;
  seen.add(id);
  const { data } = node;
  if (!isObject(data) || Object.keys(data).sort().join(",") !== "leader,name") {
    throw new Error(`layout stores the group ${id} with the data ${JSON.stringify(data) ?? "undefined"}, which is not {name, leader}`);
  }
  const { name } = data;
  if (typeof name !== "string" || [...name].length < 1 || [...name].length > 40 || name.trim() !== name) {
    throw new Error(`group ${id} stores the name ${JSON.stringify(name)}, which is not 1 to 40 characters`);
  }
  const members = readLevel(node.inner, seen);
  const side = members.find((member) => typeof member === "string" && isPlace(member));
  if (side !== undefined) throw new Error(`group ${id} holds the window sidebar ${side}`);
  if (!node.inner.cut) throw new Error(`group ${id} holds fewer than two cards`);
  return [{ card: id, name, leader: readLeader(`group ${id}`, members.map(memberId), data.leader, false), members }];
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
