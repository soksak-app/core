/**
 * The two primitives of the rule of sizes over the slicing tree, and even shares
 * (packages/soksak/docs/layout.md#cuts).
 *
 * A cut divides a rectangle along one axis into children: cards, boxes of the
 * host and cuts along the other axis. REMOVE (`withdraw`) takes a member out of
 * its cut, and the other children take its space in proportion to their sizes.
 * ADD (`insert`) puts a card beside a target: along the cut of the target, an
 * even cut gives the card 1/(k+1) and keeps every ratio, and a cut that is not
 * even takes half of the target for the card and keeps every other size; across
 * it, the target is wrapped in a new cut of two halves. `even` gives every child
 * of every cut an equal share.
 *
 * A size is a drawn size, the extent of the drawn rectangles of a child less on
 * the y axis the heads above it, and the library draws a slot at its span of the
 * whole plane less its corridor, so a size is not a span. An operation returns a
 * plan: `layout` lays the changed cuts by their weights, the grid draws the
 * result, and `correct` moves each laid span by the difference between the size
 * drawn and the size the weights ask for. Only the children of a cut that an
 * operation changes are laid again; every other card keeps its coordinates, and
 * coordinates within a billionth are one line (R1). `minimum` judges the result:
 * a node whose rectangle changed is refused below its minimum, computed
 * recursively with heads and corridors as fixed costs.
 */

import { axisOf } from './card.js';
import type { Axis, Card, Rect, Side } from './card.js';
import { cardsOf as storedCards, cloneNode, isBox, isCut } from './tree.js';
import type { BoxNode, CardNode, TreeNode } from './tree.js';

/** The drawn rectangle of each card by id. */
export type Drawn = ReadonlyMap<string, Rect>;

/** The px of the drawn size per unit of span on an axis. */
export type Rate = (axis: Axis) => number;

/** A rectangle in the coordinates of the lines, 0..1 over the sharing slots of each axis. */
export interface Extent {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** What an operation of the cuts reads of the grid: the stored tree, where each node stands, the cards, their drawing and the heads. */
export interface Input {
  root: TreeNode;
  extent(node: TreeNode): Extent;
  card(id: string): Card;
  /** Whether an id names a card or a box of the tree. */
  taken(id: string): boolean;
  drawn: Drawn;
  heads: ReadonlyMap<string, number>;
  /** Counts each node that an operation visits (packages/soksak/docs/layout.md#cuts). */
  visit(): void;
}

/** An operation laid out: `layout` gives the stored tree, and `correct` reads its drawing and returns the largest error in px. */
export interface Plan {
  layout(): TreeNode;
  correct(drawn: Drawn, rate: Rate): number;
  /** The text of the outermost changed node drawn below its minimum, or null. */
  minimum(drawn: Drawn, min: number): string | null;
}

/** What every node of the tree has: where it stood, where it is laid, its weight and the heads above it. */
interface Common {
  old: Extent;
  rect: Extent;
  /** The px of the heads above the node where it stood, and where it is laid. */
  above: number;
  placedAbove: number;
  /** The weight among the kids of its cut, when an operation set one; otherwise its size. */
  weight: number | null;
}

interface Leaf extends Common {
  kind: 'leaf';
  id: string;
  /** The card node of a card leaf; a box leaf has none. */
  card: CardNode | null;
  /** The box node of a box leaf, whose inner node the leaf holds as `inner`. */
  box: BoxNode | null;
  head: number;
  inner: Node | null;
  /** Whether the leaf keeps its span on an axis: a fixed card, or a card with a px size there. */
  held: Record<Axis, boolean>;
}

interface Cut extends Common {
  kind: 'cut';
  axis: Axis;
  kids: Node[];
  /** Whether the operation changed the kids, so they are laid again. */
  dirty: boolean;
  /** The shares that the kids keep where the cut is laid, for a cut that arrives with its node; otherwise null. */
  shares: number[] | null;
  /** Whether the last layout laid the kids by their weights. */
  laid: boolean;
  /** The correction of the span of each kid that `correct` found, in span. */
  adjust: number[];
}

type Node = Leaf | Cut;

const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom'];
const ENDS: Record<Axis, readonly ['x0' | 'y0', 'x1' | 'y1']> = { x: ['x0', 'x1'], y: ['y0', 'y1'] };
const NONE: Extent = { x0: 0, x1: 0, y0: 0, y1: 0 };

const union = (extents: Extent[]): Extent => ({
  x0: Math.min(...extents.map((e) => e.x0)),
  x1: Math.max(...extents.map((e) => e.x1)),
  y0: Math.min(...extents.map((e) => e.y0)),
  y1: Math.max(...extents.map((e) => e.y1)),
});

/** Whether a card keeps its span on an axis: fixed, or drawn at a px size there (R2). */
function holds(card: CardNode, spans: Record<Axis, number>, axis: Axis): boolean {
  if (card.fixed) return true;
  const size = axis === 'x' ? card.width : card.height;
  return size !== undefined && spans[axis] === 1;
}

function cut(axis: Axis, kids: Node[], dirty: boolean): Cut {
  const old = union(kids.map((k) => k.old));
  return {
    kind: 'cut', axis, kids, old, rect: old, above: kids[0].above, placedAbove: 0, weight: null, dirty, shares: null, laid: false,
    adjust: kids.map(() => 0),
  };
}

function cardLeaf(card: CardNode, old: Extent, spans: Record<Axis, number>): Leaf {
  return {
    kind: 'leaf', id: card.card, card, box: null, head: 0, inner: null,
    held: { x: holds(card, spans, 'x'), y: holds(card, spans, 'y') }, old, rect: old, above: 0, placedAbove: 0, weight: null,
  };
}

function boxLeaf(box: BoxNode, head: number, inner: Node, old: Extent): Leaf {
  return {
    kind: 'leaf', id: box.box, card: null, box, head, inner, held: { x: false, y: false }, old, rect: old, above: 0, placedAbove: 0,
    weight: null,
  };
}

/** Sets the px of the heads above each node where it stands: the kids of a cut along x share it, a cut along y gives it to its first kid. */
function assignAbove(node: Node, above: number): void {
  node.above = above;
  if (node.kind === 'leaf') {
    if (node.inner) assignAbove(node.inner, above + node.head);
    return;
  }
  node.kids.forEach((kid, i) => assignAbove(kid, node.axis === 'x' || i === 0 ? above : 0));
}

/** The tree of an operation with an index of its nodes: the leaf of each id, and the cut and the box leaf that hold each node. */
class Tree {
  root: Node;
  readonly byId = new Map<string, Leaf>();
  readonly parent = new Map<Node, Cut>();
  readonly owner = new Map<Node, Leaf>();

  constructor(root: Node, private readonly input: Input) {
    this.root = root;
    this.enter(root, null, null);
  }

  /** Adds `node` and the nodes below it to the index, held by the cut `parent` inside the box leaf `owner`. */
  enter(node: Node, parent: Cut | null, owner: Leaf | null): void {
    this.input.visit();
    if (parent) this.parent.set(node, parent);
    else this.parent.delete(node);
    if (owner) this.owner.set(node, owner);
    else this.owner.delete(node);
    if (node.kind === 'leaf') {
      this.byId.set(node.id, node);
      if (node.inner) this.enter(node.inner, null, node);
      return;
    }
    for (const kid of node.kids) this.enter(kid, node, owner);
  }

  /** Puts `next` where `node` stood: in its cut, inside its box leaf, or as the root. */
  replace(node: Node, next: Node): void {
    const holder = this.parent.get(node);
    const owner = this.owner.get(node);
    if (holder) holder.kids[holder.kids.indexOf(node)] = next;
    else if (owner) owner.inner = next;
    else this.root = next;
    this.enter(next, holder ?? null, owner ?? null);
  }
}

/** The tree of an operation read from the stored tree, with each leaf where it stands and each box with its head. */
function treeOf(input: Input): Tree {
  const convert = (node: TreeNode): Node => {
    input.visit();
    const old = input.extent(node);
    if (isCut(node)) {
      const out = cut(node.cut, node.kids.map((kid) => convert(kid.node)), false);
      out.old = old;
      out.rect = old;
      return out;
    }
    if (isBox(node)) return boxLeaf(node, input.heads.get(node.box) ?? 0, convert(node.inner), old);
    const card = input.card(node.card);
    return cardLeaf(node, old, { x: card.c1 - card.c0, y: card.r1 - card.r0 });
  };
  const tree = new Tree(convert(input.root), input);
  assignAbove(tree.root, 0);
  return tree;
}

/** The ids of the leaves of a node in its own tree, without the members inside its boxes. */
function members(node: Node): string[] {
  return node.kind === 'leaf' ? [node.id] : node.kids.flatMap(members);
}

/** The drawn extent of every node of the tree in px, from the drawn rectangles of its cards, computed once for an operation. */
function drawnOf(root: Node, drawn: Drawn, input: Input): Map<Node, Extent> {
  const out = new Map<Node, Extent>();
  const visit = (node: Node): Extent => {
    input.visit();
    let at: Extent;
    if (node.kind === 'cut') at = union(node.kids.map(visit));
    else if (node.inner) at = visit(node.inner);
    else {
      const r = drawn.get(node.id) as Rect;
      at = { x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h };
    }
    out.set(node, at);
    return at;
  };
  visit(root);
  return out;
}

const extentOn = (e: Extent, axis: Axis): number => (axis === 'x' ? e.x1 - e.x0 : e.y1 - e.y0);

/** The drawn size of each node where it stood, per axis, read once from the drawing before the operation. */
type Sizes = Map<Node, Extent>;

/** The size of a node among the kids of a cut along `axis`: its drawn extent, less on y the heads above it. */
const sizeAlong = (node: Node, axis: Axis, sizes: Sizes): number =>
  extentOn(sizes.get(node) ?? NONE, axis) - (axis === 'y' ? node.above : 0);

const isHeld = (node: Node, axis: Axis): boolean => node.kind === 'leaf' && node.held[axis];

const weightOf = (node: Node, axis: Axis, sizes: Sizes): number => node.weight ?? sizeAlong(node, axis, sizes);

/**
 * Lays a node into its rectangle: the kids of a cut that changed or whose rectangle moved on its axis by their weights, and the kids of
 * a cut that arrives with its node by the shares it keeps.
 */
function place(node: Node, rect: Extent, above: number, sizes: Sizes, input: Input): void {
  input.visit();
  node.rect = rect;
  node.placedAbove = above;
  if (node.kind === 'leaf') {
    if (node.inner) place(node.inner, rect, above + node.head, sizes, input);
    return;
  }
  const axis = node.axis;
  const [lo, hi] = ENDS[axis];
  const kept = !node.dirty && !node.shares && rect[lo] === node.old[lo] && rect[hi] === node.old[hi] && above === node.above;
  node.laid = !kept && !node.shares;
  const spans = node.kids.map((kid) => kid.old[hi] - kid.old[lo]);
  if (node.shares) {
    const shares = node.shares;
    node.kids.forEach((_, i) => {
      spans[i] = (rect[hi] - rect[lo]) * shares[i];
    });
  } else if (!kept) {
    let free = rect[hi] - rect[lo];
    node.kids.forEach((kid, i) => {
      if (isHeld(kid, axis)) free -= spans[i];
    });
    const sharing = node.kids.filter((kid) => !isHeld(kid, axis));
    const total = sharing.reduce((a, kid) => a + weightOf(kid, axis, sizes), 0);
    node.kids.forEach((kid, i) => {
      if (isHeld(kid, axis)) return;
      const share = total > 0 ? weightOf(kid, axis, sizes) / total : 1 / sharing.length;
      spans[i] = Math.max(0, Math.max(0, free) * share + node.adjust[i]);
    });
  }
  let at = rect[lo];
  node.kids.forEach((kid, i) => {
    const last = i === node.kids.length - 1;
    const from = kept ? kid.old[lo] : at;
    const end = kept ? kid.old[hi] : last ? rect[hi] : at + spans[i];
    place(kid, { ...rect, [lo]: from, [hi]: end }, axis === 'x' || i === 0 ? above : 0, sizes, input);
    at = end;
  });
}

/**
 * The stored node of a laid node: a cut takes the shares of the rectangles that its kids were laid at, a kid cut along the axis of its
 * cut gives that cut its kids, and a cut of one kid is that kid, so the tree stays canonical.
 */
function storedOf(node: Node): TreeNode {
  if (node.kind === 'leaf') {
    if (node.inner) {
      const box = node.box as BoxNode;
      return { box: box.box, ...(box.data !== undefined ? { data: box.data } : {}), inner: storedOf(node.inner) };
    }
    return cloneNode(node.card as CardNode);
  }
  const [lo, hi] = ENDS[node.axis];
  const total = node.rect[hi] - node.rect[lo];
  const kids: { share: number; node: TreeNode }[] = [];
  for (const kid of node.kids) {
    const share = total > 0 ? (kid.rect[hi] - kid.rect[lo]) / total : 1 / node.kids.length;
    const stored = storedOf(kid);
    if (isCut(stored) && stored.cut === node.axis) for (const k of stored.kids) kids.push({ share: share * k.share, node: k.node });
    else kids.push({ share, node: stored });
  }
  return kids.length === 1 ? kids[0].node : { cut: node.axis, kids };
}

/** Moves each span that the last layout laid by the difference between its drawn size and the size its weight asks for. */
function correct(root: Node, drawn: Drawn, rate: Rate, sizes: Sizes, input: Input): number {
  const now = drawnOf(root, drawn, input);
  let worst = 0;
  const visit = (node: Node) => {
    input.visit();
    if (node.kind === 'leaf') {
      if (node.inner) visit(node.inner);
      return;
    }
    node.kids.forEach(visit);
    if (!node.laid) return;
    const axis = node.axis;
    const each = rate(axis);
    if (!(each > 0)) return;
    const sharing = node.kids.map((_, i) => i).filter((i) => !isHeld(node.kids[i], axis));
    const drawnSizes = node.kids.map((kid) => extentOn(now.get(kid) as Extent, axis) - (axis === 'y' ? kid.placedAbove : 0));
    const total = sharing.reduce((a, i) => a + weightOf(node.kids[i], axis, sizes), 0);
    const room = sharing.reduce((a, i) => a + drawnSizes[i], 0);
    for (const i of sharing) {
      const want = total > 0 ? (room * weightOf(node.kids[i], axis, sizes)) / total : room / sharing.length;
      const error = drawnSizes[i] - want;
      worst = Math.max(worst, Math.abs(error));
      node.adjust[i] -= error / each;
    }
  };
  visit(root);
  return worst;
}

/** The node of what arrives: a new card, or a card or a box that left, whose cuts keep their shares where it lands. */
function arriving(node: TreeNode): Node {
  if (isCut(node)) {
    const kids = node.kids.map((kid) => arriving(kid.node));
    const out = cut(node.cut, kids, true);
    out.shares = node.kids.map((kid) => kid.share);
    return out;
  }
  if (isBox(node)) return boxLeaf(node, 0, arriving(node.inner), NONE);
  return cardLeaf(cloneNode(node) as CardNode, NONE, { x: 1, y: 1 });
}

/**
 * The target of an insert: the node of one id, or the neighbouring kids of one cut that hold exactly the ids of the list, which become a
 * cut of their own inside it.
 */
/** Neighbouring kids `first` to `last` of the cut `holder`: the target of an insert along that cut. */
interface Run {
  holder: Cut;
  first: number;
  last: number;
}

/**
 * The target of an insert toward an axis: the node of one member, or the neighbouring kids of one cut that hold exactly the
 * members. A run of kids is the target itself when the insert goes along its cut, so the node joins that cut; across it, the run
 * becomes a cut of its own that the insert wraps.
 */
function targetNode(tree: Tree, target: string | readonly string[], sizes: Sizes, axis: Axis): Node | Run {
  const list = typeof target === 'string' ? [target] : [...target];
  const hits = list.map((id) => {
    const hit = tree.byId.get(id);
    if (!hit) throw new Error(`card ${id} is not a member of the layout`);
    return hit;
  });
  if (list.length === 1) return hits[0];
  const refused = () => new Error(`cards ${list.join(', ')} are not neighbours of one cut`);
  const wanted = new Set(list);
  // The cut that holds every listed node is the lowest cut above the first whose leaves count all of them.
  let level: Cut | null = null;
  for (let at = tree.parent.get(hits[0]); at; at = tree.parent.get(at)) {
    if (members(at).filter((id) => wanted.has(id)).length === wanted.size) {
      level = at;
      break;
    }
  }
  if (!level) throw refused();
  const holder = level;
  const touched = holder.kids.map((kid, i) => (members(kid).some((id) => wanted.has(id)) ? i : -1)).filter((i) => i >= 0);
  const first = touched[0];
  const last = touched[touched.length - 1];
  const span = holder.kids.slice(first, last + 1);
  const held = span.flatMap(members);
  if (held.length !== wanted.size || !held.every((id) => wanted.has(id))) throw refused();
  if (first === 0 && last === holder.kids.length - 1) return holder;
  if (holder.axis === axis) return { holder, first, last };
  const sub = cut(holder.axis, span, false);
  sub.weight = span.reduce((a, k) => a + weightOf(k, holder.axis, sizes), 0);
  sizes.set(sub, union(span.map((k) => sizes.get(k) as Extent)));
  holder.kids.splice(first, span.length, sub);
  holder.adjust = holder.kids.map(() => 0);
  tree.enter(sub, holder, tree.owner.get(holder) ?? null);
  return sub;
}

/** The difference in px under which the sizes of the kids of a cut are equal, so the cut is even. */
const EVEN = 0.5;

/** Whether the kids of a cut that keep no span on its axis have one size. */
function isEven(into: Cut, sizes: Sizes): boolean {
  const all = into.kids.filter((kid) => !isHeld(kid, into.axis)).map((kid) => weightOf(kid, into.axis, sizes));
  return all.every((size) => Math.abs(size - all[0]) < EVEN);
}

/**
 * Adds the node `arriving` beside `node` toward `side`. Along the cut of the target, an even cut gives it 1/(k+1) and keeps every ratio;
 * a cut that is not even takes half of the target less the new corridor, `gap`, the kid toward `side` when the target is the cut itself,
 * and keeps every other size. Across the cut, the target is wrapped in a new cut of two halves.
 */
function addBeside(tree: Tree, target: Node | Run, side: Side, coming: Node, gap: number, sizes: Sizes): void {
  const axis = axisOf(side);
  const after = side === 'right' || side === 'bottom';
  const insertInto = (into: Cut, at: number, payers: Node[]): void => {
    const sharing = into.kids.filter((kid) => !isHeld(kid, axis));
    const even = isEven(into, sizes);
    sharing.forEach((kid) => {
      kid.weight = weightOf(kid, axis, sizes);
    });
    const paying = payers.filter((kid) => !isHeld(kid, axis));
    if (even || !paying.length) {
      const total = sharing.reduce((a, kid) => a + (kid.weight as number), 0);
      coming.weight = sharing.length ? total / sharing.length : 1;
    } else {
      // The target gives half of its size, the new corridor included, so every other kid keeps its drawn size; the kids of a run
      // give it in proportion and keep their ratios.
      const sum = paying.reduce((a, kid) => a + (kid.weight as number), 0);
      const half = Math.max(0, sum - gap) / 2;
      for (const kid of paying) kid.weight = sum > 0 ? ((kid.weight as number) * half) / sum : 0;
      coming.weight = half;
    }
    into.kids.splice(at, 0, coming);
    into.adjust = into.kids.map(() => 0);
    into.dirty = true;
    tree.enter(coming, into, tree.owner.get(into) ?? null);
  };
  if ('holder' in target) {
    insertInto(target.holder, after ? target.last + 1 : target.first, target.holder.kids.slice(target.first, target.last + 1));
    return;
  }
  const node = target;
  const holder = tree.parent.get(node) ?? null;
  if (node.kind === 'cut' && node.axis === axis) {
    insertInto(node, after ? node.kids.length : 0, [after ? node.kids[node.kids.length - 1] : node.kids[0]]);
    return;
  }
  if (holder && holder.axis === axis) {
    insertInto(holder, holder.kids.indexOf(node) + (after ? 1 : 0), [node]);
    return;
  }
  const weight = holder ? weightOf(node, holder.axis, sizes) : null;
  const next = cut(axis, after ? [node, coming] : [coming, node], true);
  next.old = node.old;
  next.rect = node.old;
  next.above = node.above;
  next.weight = weight;
  sizes.set(next, sizes.get(node) as Extent);
  node.weight = 1;
  coming.weight = 1;
  tree.replace(node, next);
}

/**
 * The size that a node needs on an axis, in the px of the grid rectangles: a card its minimum and on y the heads drawn inside its
 * rectangle; a box the need of its inner node; a cut along the axis the needs of its kids and the corridors between them; a cut across
 * it the largest need of its kids. A kid that keeps its span needs the size it is drawn at.
 */
function need(node: Node, axis: Axis, now: Map<Node, Extent>, min: number): number {
  const extent = (n: Node): number => extentOn(now.get(n) as Extent, axis);
  if (node.kind === 'leaf') {
    if (node.inner) return need(node.inner, axis, now, min);
    if (node.held[axis]) return extent(node);
    return min + (axis === 'y' ? node.placedAbove : 0);
  }
  const kids = node.kids.map((kid) => need(kid, axis, now, min));
  if (node.axis !== axis) return Math.max(...kids);
  const corridors = extent(node) - node.kids.reduce((a, kid) => a + extent(kid), 0);
  return kids.reduce((a, n) => a + n, 0) + corridors;
}

/** The text of the outermost node whose rectangle the plan changed and that is drawn below its minimum, or null. */
function belowMinimum(root: Node, drawn: Drawn, min: number, input: Input): string | null {
  const now = drawnOf(root, drawn, input);
  const text = (n: number) => String(Math.round(n));
  const visit = (node: Node): string | null => {
    input.visit();
    const moved = (['x0', 'x1', 'y0', 'y1'] as const).some((key) => Math.abs(node.rect[key] - node.old[key]) > 1e-9);
    if (node.kind === 'leaf' && moved) {
      const has = now.get(node) as Extent;
      const w = has.x1 - has.x0;
      const h = has.y1 - has.y0;
      const needs = { x: need(node, 'x', now, min), y: need(node, 'y', now, min) };
      if (w < needs.x - EVEN || h < needs.y - EVEN) {
        return `card ${node.id} would be ${text(w)}x${text(h)}, below its minimum ${text(needs.x)}x${text(needs.y)}`;
      }
    }
    if (node.kind === 'leaf') return node.inner ? visit(node.inner) : null;
    for (const kid of node.kids) {
      const found = visit(kid);
      if (found) return found;
    }
    return null;
  };
  return visit(root);
}

function planOf(tree: Tree, sizes: Sizes, input: Input): Plan {
  return {
    layout: () => {
      place(tree.root, tree.root.old, 0, sizes, input);
      return storedOf(tree.root);
    },
    correct: (drawn, rate) => correct(tree.root, drawn, rate, sizes, input),
    minimum: (drawn, min) => belowMinimum(tree.root, drawn, min, input),
  };
}

/** The tree of an operation and the drawn size of each of its nodes before it. */
function start(input: Input): { tree: Tree; sizes: Sizes } {
  const tree = treeOf(input);
  return { tree, sizes: drawnOf(tree.root, input.drawn, input) };
}

/** ADD: the plan of adding `node`, a new card or what `withdraw` returned, beside `target` toward `side`. */
export function insertNode(input: Input, target: string | readonly string[], side: Side, node: TreeNode, gap: number): Plan {
  if (!SIDES.includes(side)) throw new Error(`unknown side ${String(side)}; use left, right, top or bottom`);
  const ids = [isBox(node) ? node.box : isCut(node) ? null : node.card, ...storedCards(node).map((c) => c.card)];
  const member = ids.find((id) => id !== null && input.taken(id));
  if (member !== undefined && member !== null) throw new Error(`card ${member} is a member of the layout`);
  const { tree, sizes } = start(input);
  addBeside(tree, targetNode(tree, target, sizes, axisOf(side)), side, arriving(node), gap, sizes);
  return planOf(tree, sizes, input);
}

/** REMOVE: the plan of taking the card or the box `id` out of its cut, and the stored node that left. */
export function withdrawNode(input: Input, id: string, cards: readonly Card[]): { plan: Plan; left: TreeNode } {
  const { tree, sizes } = start(input);
  const node = tree.byId.get(id);
  if (!node) throw new Error(`card ${id} is not a member of the layout`);
  if (node.card?.fixed) throw new Error(`card ${id} is fixed and does not leave`);
  const holder = tree.parent.get(node);
  const gone = new Set(node.box ? storedCards(node.box).map((c) => c.card) : [id]);
  if (!holder || cards.every((card) => card.fixed || gone.has(card.id))) throw new Error(`card ${id} is the last card of the layout`);
  const axis = holder.axis;
  const rest = holder.kids.filter((kid) => kid !== node);
  if (rest.every((kid) => isHeld(kid, axis))) throw new Error(`card ${id} leaves no card of its cut that takes its space`);
  const left = cloneNode(node.box ?? (node.card as CardNode));
  rest.forEach((kid) => {
    if (!isHeld(kid, axis)) kid.weight = weightOf(kid, axis, sizes);
  });
  // A cut left with one kid lays it across its whole rectangle, and storedOf gives the cut of one kid as that kid.
  holder.kids = rest;
  holder.adjust = rest.map(() => 0);
  holder.dirty = true;
  return { plan: planOf(tree, sizes, input), left };
}

/** Even: the plan of giving every kid of every cut an equal share. */
export function evenCuts(input: Input): Plan {
  const { tree, sizes } = start(input);
  const mark = (node: Node): void => {
    if (node.kind === 'leaf') {
      if (node.inner) mark(node.inner);
      return;
    }
    node.dirty = true;
    node.kids.forEach((kid) => {
      kid.weight = 1;
      mark(kid);
    });
  };
  mark(tree.root);
  return planOf(tree, sizes, input);
}
