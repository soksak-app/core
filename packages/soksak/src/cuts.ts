/**
 * The two primitives of the rule of sizes over the slicing tree, and even shares
 * (packages/soksak/docs/layout.md#cuts).
 *
 * A cut divides a rectangle along one axis into children: cards, boxes of the
 * host and cuts along the other axis. Every rule works on the fractions of the
 * stored tree; the grid draws a kid at its fraction of what its cut has left once
 * the corridors, the px sizes, the frames and the heads are laid, so equal
 * fractions draw equal sizes. REMOVE (`withdraw`) takes a member out of its cut,
 * and the other kids that keep no size of their own take its fraction by one
 * factor. ADD (`insert`) puts a node beside a target: along the cut of the
 * target, an even cut gives the node 1/(k+1) and keeps every ratio, and a cut
 * that is not even gives the node half of the fraction of the target; across it,
 * the target is wrapped in a new cut of two halves. `even` gives the kids of
 * every cut equal fractions. An operation returns the stored tree it makes; the
 * grid lays it and refuses a result that draws a changed node below its minimum.
 */

import { axisOf } from './card.js';
import type { Axis, Side } from './card.js';
import { cardsOf, cloneNode, isBox, isCard, isCut } from './tree.js';
import type { CardNode, CutNode, Kid, TreeNode } from './tree.js';

/** What an operation of the cuts reads of the grid. */
export interface Input {
  /** A copy of the stored tree, which the operation changes. */
  root: TreeNode;
  /** Whether an id names a card or a box of the grid. */
  taken(id: string): boolean;
  /**
   * Whether a node keeps its size on an axis whatever its fraction: a fixed card,
   * or a node drawn at a px size there.
   */
  keeps(node: TreeNode, axis: Axis): boolean;
  /** The px size of a node on an axis as the grid draws it now, its corridors and frames left out; a new node has none. */
  content(node: TreeNode, axis: Axis): number;
  /** The corridor of an axis in px. */
  corridor(axis: Axis): number;
  /** Counts each node that an operation visits (packages/soksak/docs/layout.md#cuts). */
  visit(): void;
}

const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom'];

/** The fractions under which two kids are of one size, so their cut is even. */
const EVEN = 1e-9;

/** The cut of each node of the tree and the box around each inner node, and the node of each id. */
class Index {
  readonly parent = new Map<TreeNode, CutNode>();
  readonly byId = new Map<string, TreeNode>();

  constructor(public root: TreeNode, private readonly input: Input) {
    this.enter(root, null);
  }

  enter(node: TreeNode, parent: CutNode | null): void {
    this.input.visit();
    if (parent) this.parent.set(node, parent);
    if (isCard(node)) {
      this.byId.set(node.card, node);
    } else if (isBox(node)) {
      this.byId.set(node.box, node);
      this.enter(node.inner, null);
    } else {
      for (const kid of node.kids) this.enter(kid.node, node);
    }
  }

  /** Puts `next` where `node` stands: in its cut, inside its box, or as the root. */
  replace(node: TreeNode, next: TreeNode): void {
    const holder = this.parent.get(node);
    if (holder) {
      const at = holder.kids.findIndex((k) => k.node === node);
      // A cut along the axis of its cut gives that cut its kids, so the tree stays canonical.
      if (isCut(next) && next.cut === holder.cut) {
        const axis = holder.cut;
        const share = holder.kids[at].share;
        holder.kids.splice(at, 1, ...next.kids.map((kid) => ({ share: share * kid.share, node: kid.node })));
        for (const kid of next.kids) this.enter(kid.node, holder);
        // The kids of the cut that joins are drawn at the sizes they had, and so is every other kid: the corridors between them
        // are costs of the one cut now, so each kid takes its drawn size over theirs.
        const taking = holder.kids;
        const drawn = taking.map((kid) => this.input.content(kid.node, axis));
        const total = drawn.reduce((a, size) => a + size, 0);
        const shared = taking.reduce((a, kid) => a + kid.share, 0);
        if (total > 0 && drawn.every((size) => size > 0)) taking.forEach((kid, i) => {
          kid.share = (drawn[i] / total) * shared;
        });
        return;
      }
      holder.kids[at].node = next;
      this.enter(next, holder);
      return;
    }
    for (const box of this.byId.values()) {
      if (isBox(box) && box.inner === node) {
        box.inner = next;
        this.enter(next, null);
        return;
      }
    }
    this.root = next;
    this.enter(next, null);
  }
}

/** The ids of the cards and boxes of a node in its own tree, without the members inside its boxes. */
function members(node: TreeNode): string[] {
  if (isCard(node)) return [node.card];
  if (isBox(node)) return [node.box];
  return node.kids.flatMap((kid) => members(kid.node));
}

/** Neighbouring kids `first` to `last` of the cut `holder`: the target of an insert along that cut. */
interface Run {
  holder: CutNode;
  first: number;
  last: number;
}

/**
 * The target of an insert toward an axis: the node of one member, or the neighbouring kids of one cut that hold exactly the
 * members. A run of kids is the target itself when the insert goes along its cut, so the node joins that cut; across it, the run
 * becomes a cut of its own that the insert wraps.
 */
function targetOf(index: Index, target: string | readonly string[], axis: Axis): TreeNode | Run {
  const list = typeof target === 'string' ? [target] : [...target];
  const hits = list.map((id) => {
    const hit = index.byId.get(id);
    if (!hit) throw new Error(`card ${id} is not a member of the layout`);
    return hit;
  });
  if (list.length === 1) return hits[0];
  const refused = () => new Error(`cards ${list.join(', ')} are not neighbours of one cut`);
  const wanted = new Set(list);
  // The cut that holds every listed node is the lowest cut above the first whose members count all of them.
  let holder: CutNode | null = null;
  for (let at = index.parent.get(hits[0]); at; at = index.parent.get(at)) {
    if (members(at).filter((id) => wanted.has(id)).length === wanted.size) {
      holder = at;
      break;
    }
  }
  if (!holder) throw refused();
  const level = holder;
  const touched = level.kids.map((kid, i) => (members(kid.node).some((id) => wanted.has(id)) ? i : -1)).filter((i) => i >= 0);
  const first = touched[0];
  const last = touched[touched.length - 1];
  const span = level.kids.slice(first, last + 1);
  const held = span.flatMap((kid) => members(kid.node));
  if (held.length !== wanted.size || !held.every((id) => wanted.has(id))) throw refused();
  if (first === 0 && last === level.kids.length - 1) return level;
  if (level.cut === axis) return { holder: level, first, last };
  const total = span.reduce((a, kid) => a + kid.share, 0);
  const sub: CutNode = { cut: level.cut, kids: span.map((kid) => ({ share: kid.share / total, node: kid.node })) };
  level.kids.splice(first, span.length, { share: total, node: sub });
  index.enter(sub, level);
  return sub;
}

/** The kids of a cut that take a fraction: the kids that keep no size of their own on its axis. */
const sharing = (cut: CutNode, input: Input): Kid[] => cut.kids.filter((kid) => !input.keeps(kid.node, cut.cut));

/** Whether the kids of a cut that take a fraction have one fraction. */
function isEven(cut: CutNode, input: Input): boolean {
  const all = sharing(cut, input).map((kid) => kid.share);
  return all.every((share) => Math.abs(share - all[0]) <= EVEN);
}

/** Makes the fractions of a cut sum to 1, by one factor, so every ratio holds. */
function normalize(cut: CutNode): void {
  const total = cut.kids.reduce((a, kid) => a + kid.share, 0);
  for (const kid of cut.kids) kid.share /= total;
}

/**
 * Adds the node `coming` into the cut `into` at `at`, paid by the kids `payers`. An even cut gives it 1/(k+1) and keeps every
 * ratio; a cut that is not even gives it half of the fraction of the payers, which keep their ratios, and every other kid keeps its
 * fraction. A node that keeps a px size on the axis takes no fraction: an even cut keeps every ratio, and a cut that is not even
 * takes its px and its corridor from the payers alone, so every other kid keeps its drawn size.
 */
function insertInto(into: CutNode, at: number, payers: Kid[], coming: TreeNode, input: Input): void {
  const axis = into.cut;
  const shares = sharing(into, input);
  const paying = payers.filter((kid) => !input.keeps(kid.node, axis));
  const even = isEven(into, input) || paying.length === 0;
  const fresh: Kid = { share: 0, node: coming };
  if (input.keeps(coming, axis)) {
    const sum = shares.reduce((a, kid) => a + kid.share, 0);
    fresh.share = sum > 0 && shares.length ? sum / (shares.length + 1) : 1 / (into.kids.length + 1);
    if (!even) {
      // The drawn size of every kid that takes a fraction: the payers give the px of the node and the new corridor between them.
      const drawn = shares.map((kid) => input.content(kid.node, axis));
      const paid = paying.reduce((a, kid) => a + input.content(kid.node, axis), 0);
      const owed = input.content(coming, axis) + input.corridor(axis);
      if (paid <= owed) throw new Error(`the kids beside the node cannot give ${Math.round(owed)} px`);
      shares.forEach((kid, i) => {
        kid.share = paying.includes(kid) ? drawn[i] * (1 - owed / paid) : drawn[i];
      });
      const total = shares.reduce((a, kid) => a + kid.share, 0);
      for (const kid of shares) kid.share *= sum / total;
    }
  } else if (even) {
    const sum = shares.reduce((a, kid) => a + kid.share, 0);
    const k = shares.length;
    for (const kid of shares) kid.share *= k / (k + 1);
    fresh.share = k ? sum / (k + 1) : 1 / (into.kids.length + 1);
  } else {
    const paid = paying.reduce((a, kid) => a + kid.share, 0);
    for (const kid of paying) kid.share /= 2;
    fresh.share = paid / 2;
  }
  into.kids.splice(at, 0, fresh);
  normalize(into);
}

/**
 * Adds `coming` beside `target` toward `side`. Along the cut of the target, `insertInto` gives it its fraction; when the target is
 * a cut along the axis of the side, the target is the whole level and every kid pays. Across the cut, the target is wrapped in a
 * new cut of two halves.
 */
function addBeside(index: Index, target: TreeNode | Run, side: Side, coming: TreeNode, input: Input): void {
  const axis = axisOf(side);
  const after = side === 'right' || side === 'bottom';
  if ('holder' in target) {
    const { holder, first, last } = target;
    insertInto(holder, after ? last + 1 : first, holder.kids.slice(first, last + 1), coming, input);
    index.enter(coming, holder);
    return;
  }
  if (isCut(target) && target.cut === axis) {
    insertInto(target, after ? target.kids.length : 0, [...target.kids], coming, input);
    index.enter(coming, target);
    return;
  }
  const holder = index.parent.get(target);
  if (holder && holder.cut === axis) {
    const at = holder.kids.findIndex((kid) => kid.node === target);
    insertInto(holder, at + (after ? 1 : 0), [holder.kids[at]], coming, input);
    index.enter(coming, holder);
    return;
  }
  const pair = after ? [target, coming] : [coming, target];
  index.replace(target, { cut: axis, kids: pair.map((node) => ({ share: 0.5, node })) });
}

/** Takes the px size on `axis` from a card that fills a cut alone, which has no size of its own there. */
function alone(node: TreeNode, axis: Axis): TreeNode {
  if (isCard(node)) {
    if (axis === 'x') delete node.width;
    else delete node.height;
  }
  return node;
}

/** ADD: the stored tree with `node`, a new card or what `withdraw` returned, beside `target` toward `side`. */
export function insertNode(input: Input, target: string | readonly string[], side: Side, node: TreeNode): TreeNode {
  if (!SIDES.includes(side)) throw new Error(`unknown side ${String(side)}; use left, right, top or bottom`);
  const ids = [isBox(node) ? node.box : isCut(node) ? null : node.card, ...cardsOf(node).map((c) => c.card)];
  const member = ids.find((id) => id !== null && input.taken(id));
  if (member !== undefined && member !== null) throw new Error(`card ${member} is a member of the layout`);
  const index = new Index(input.root, input);
  addBeside(index, targetOf(index, target, axisOf(side)), side, cloneNode(node), input);
  return index.root;
}

/** ADD beside a node of the stored tree of `input`: the stored tree with `node` beside `target` toward `side`. */
export function insertBeside(input: Input, target: TreeNode, side: Side, node: TreeNode): TreeNode {
  const index = new Index(input.root, input);
  addBeside(index, target, side, cloneNode(node), input);
  return index.root;
}

/** REMOVE: the stored tree without the card or the box `id`, and the stored node that left. */
export function withdrawNode(input: Input, id: string, cards: readonly { id: string; fixed: boolean }[]): { root: TreeNode; left: TreeNode } {
  const index = new Index(input.root, input);
  const node = index.byId.get(id);
  if (!node) throw new Error(`card ${id} is not a member of the layout`);
  if (isCard(node) && node.fixed) throw new Error(`card ${id} is fixed and does not leave`);
  const holder = index.parent.get(node);
  const gone = new Set(isBox(node) ? cardsOf(node).map((c) => c.card) : [id]);
  if (!holder || cards.every((card) => card.fixed || gone.has(card.id))) throw new Error(`card ${id} is the last card of the layout`);
  const axis = holder.cut;
  const i = holder.kids.findIndex((kid) => kid.node === node);
  const share = holder.kids[i].share;
  holder.kids.splice(i, 1);
  // A fixed card keeps its size; every other kid takes a part of the fraction, which a kid with a px size draws at its size.
  const taking = holder.kids.filter((kid) => !(isCard(kid.node) && kid.node.fixed));
  if (!taking.length) throw new Error(`card ${id} leaves no card of its cut that takes its space`);
  const free = taking.reduce((a, kid) => a + kid.share, 0);
  for (const kid of taking) kid.share *= (free + share) / free;
  if (holder.kids.length === 1) index.replace(holder, alone(holder.kids[0].node, axis));
  return { root: index.root, left: node };
}

/** Even: the stored tree with equal fractions for the kids of every cut that take one. */
export function evenCuts(input: Input): TreeNode {
  const visit = (node: TreeNode): void => {
    input.visit();
    if (isBox(node)) {
      visit(node.inner);
      return;
    }
    if (!isCut(node)) return;
    const shares = sharing(node, input);
    const sum = shares.reduce((a, kid) => a + kid.share, 0);
    for (const kid of shares) kid.share = sum / shares.length;
    for (const kid of node.kids) visit(kid.node);
  };
  visit(input.root);
  return input.root;
}

export type { CardNode };
