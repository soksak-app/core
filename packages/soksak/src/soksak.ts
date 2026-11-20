/**
 * A soksak over a slicing tree.
 *
 * The state is the canonical slicing tree of the plane (`tree.ts`,
 * packages/soksak/docs/layout.md#the-model). After every change the grid
 * derives from it `xs` and `ys`, every coordinate at which the rectangle of a
 * node starts or ends, normalised 0..1 over the slots that share the remaining
 * space, and each card as a span of indices into them. A slot with a px size is
 * drawn at that size whatever its span, so a line's px position is not its value
 * times the plane size. Two cards that meet reference the same index, so their
 * shared boundary is one value.
 *
 * The operations of the structure (split, close, insert, move, arrange and the
 * cut operations) change the tree. The operations of a line (a boundary drag and
 * the settle of a slot to a px width) move the derived lines, and `commit`
 * writes the shares that the moved lines give back into the cuts of the tree,
 * whose structure stays. `geometry.ts` computes the coordinates.
 */

import { SIDES, SPAN, axisOf, fixedSize, isAhead, other } from './card.js';
import type { Axis, Card, Rect, Side } from './card.js';
import {
  cardInset,
  crossing,
  dividers,
  frameOf,
  linesRead,
  halfCorridor,
  heldSizes,
  holdsSizes,
  inset,
  linePositions,
  rectIn,
  rectOf,
  rules,
  sharePerSpan,
  zoneAt,
} from './geometry.js';
import type { Divider, Frames, Plane, Rule, ZoneHit, ZoneOptions } from './geometry.js';

export type { Divider, Rule, Zone, ZoneHit, ZoneOptions } from './geometry.js';
import { evenCuts, exchangeNodes, groupNode, insertBeside, insertNode, unwrapNode, vacatesNode, withdrawNode } from './cuts.js';
import type { Input } from './cuts.js';
import { EPS, cardsOf, checkState, cloneNode, isBox, isCard, isCut } from './tree.js';
import type { BoxNode, CardNode, CutNode, SoksakState, TreeNode } from './tree.js';

export type { Axis, Card, CardInit, Rect, Side } from './card.js';
export type { BoxNode, CardNode, CutNode, Kid, SoksakState, TreeNode } from './tree.js';
export { checkState } from './tree.js';

/** `merge`: a dragged boundary snaps onto a neighbouring line and the two combine. */
export type SnapMode = 'merge' | 'off';

/**
 * What the frame of a box takes on its left, right and bottom side: `corridor` one corridor, so a box stands one corridor around
 * its inner node; `none` nothing, so a box is drawn at the rectangle of its inner node and the corridor between two boxes is one
 * corridor, as at a seam where the corridor is the one border line that two boxes share.
 */
export type FrameMode = 'corridor' | 'none';

/** Refuses a value that is no frame mode, naming it. */
function frameMode(mode: unknown): FrameMode {
  if (mode !== 'corridor' && mode !== 'none') throw new Error(`soksak: frames is ${JSON.stringify(mode)}; use "corridor" or "none"`);
  return mode;
}

export interface SoksakOptions {
  /** Gap between two cards, in px. Half of it insets every inner edge. Default 24. */
  gap?: number;
  /** Smallest card edge, in px. Splitting, dragging and resizing all respect it. Default 96. */
  minSize?: number;
  /** Smallest hit area, in px. Independent of `gap` so a zero gap is still draggable. Default 11. */
  grabSize?: number;
  /** How close a dragged boundary must come to a neighbour to snap onto it, in px. Default 7. */
  snapDistance?: number;
  /** How a dragged boundary snaps. Default `merge`. */
  snap?: SnapMode;
  /** What the frame of a box takes on each side but its top. Default `corridor`. */
  frames?: FrameMode;
  /** Plane width in px. Default 0 until `resize`. */
  width?: number;
  /** Plane height in px. Default 0 until `resize`. */
  height?: number;
}

/** The lines of an axis at which the rectangle of a node starts and ends: c0, c1, r0 and r1. */
type NodeLines = [number, number, number, number];

/** A rectangle by its edges: in the coordinates of the lines, or the insets of a node from its slot in px. */
interface Extent {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** The node that holds a node: a cut with the index of the node among its kids, or a box with index -1. */
interface Holding {
  node: CutNode | BoxNode;
  at: number;
}

const ENDS: Record<Axis, readonly ['x0' | 'y0', 'x1' | 'y1']> = { x: ['x0', 'x1'], y: ['y0', 'y1'] };

/**
 * The lines of coordinates: coordinates within EPS of the line before are that
 * line (R1), because two cuts laid alike, such as two rows of equal shares,
 * reach one coordinate through different sums.
 */
function linesOf(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values.sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] >= EPS) out.push(v);
  return out;
}

/** The index of the line of v in the ascending lines: the last line at or below v within EPS, by bisection. */
function lineOf(lines: readonly number[], v: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] > v + EPS) hi = mid;
    else lo = mid + 1;
  }
  return lo - 1;
}

// Every caller passes a range in order: boundaryRange collapses an inverted one
// before returning, the line array is non-decreasing, and cutAt answers null
// before it would build one.
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Writes a px size on an axis of a card or a card node, or removes it with null. */
function sizeOn(card: { width?: number; height?: number }, axis: Axis, px: number | null): void {
  const key = axis === 'x' ? 'width' : 'height';
  if (px === null) delete card[key];
  else card[key] = px;
}

export class Soksak {
  /** The state: the slicing tree of the plane. */
  private root: TreeNode = { card: 'card', fixed: false };
  // Derived from the tree by `derive` after every change.
  private xs: number[] = [0, 1];
  private ys: number[] = [0, 1];
  private list: Card[] = [];
  private byId = new Map<string, Card>();
  private leaves = new Map<string, CardNode>();
  private boxes = new Map<string, BoxNode>();
  private at = new Map<TreeNode, NodeLines>();
  private spots = new Map<TreeNode, Extent>();
  /** The px that each node stands inside its slot: the corridors and frames on each side, and on top the heads above it. */
  private insets = new Map<TreeNode, Extent>();
  /** The corridor of each axis in px, which the last derive laid. */
  private unit: Record<Axis, number> = { x: 0, y: 0 };
  /** The px position of each line per axis from the last layout of the tree, or null on a plane with no size. */
  private linesAt: Record<Axis, number[]> | null = null;
  /** The px of the heads of the boxes that start on the top line of each card. */
  private above = new Map<string, number>();
  /** Whether an operation moved the lines, so the commit reads the fractions from them. */
  private moved = false;
  private up = new Map<TreeNode, Holding>();
  /** The px that the host draws inside the top of each box by id, which `setHeads` set. */
  private heads: ReadonlyMap<string, number> = new Map();
  /** The nodes that the last operation visited, and how deep the public operations that run now are nested. */
  private visited = 0;
  private depth = 0;
  private w: number;
  private h: number;
  private seq = 0;
  private splitMemo = new Map<string, boolean>();
  /** True while canSplit runs a trial split and restores the state. */
  private probing = false;

  private g = 24;

  /** Gap between two cards, in px. Clamped to 0; a negative value overlaps cards. */
  get gap(): number {
    return this.g;
  }

  set gap(px: number) {
    if (!Number.isFinite(px) || px < 0) return;
    this.g = px;
    this.splitMemo.clear();
    // The fractions stay, and the tree is laid with the new corridor.
    if (this.list.length) this.derive();
  }
  private min: number;

  /** Minimum drawn size of a card on either axis. */
  get minSize(): number {
    return this.min;
  }

  /** Assigning it clears the values cached against the previous one. */
  set minSize(px: number) {
    if (!Number.isFinite(px) || px < 0) return;
    this.min = px;
    this.splitMemo.clear();
  }


  private grab: number;

  /** Smallest grab area of a boundary, in px. */
  get grabSize(): number {
    return this.grab;
  }

  set grabSize(px: number) {
    if (!Number.isFinite(px) || px < 0) return;
    this.grab = px;
  }

  private snapAt: number;

  /** How near a dragged boundary must come to a neighbour to land on it, in px. */
  get snapDistance(): number {
    return this.snapAt;
  }

  set snapDistance(px: number) {
    if (!Number.isFinite(px) || px < 0) return;
    this.snapAt = px;
  }

  private snapMode: SnapMode;

  private frameAt: FrameMode;

  /** What the frame of a box takes on its left, right and bottom side (R5). */
  get frames(): FrameMode {
    return this.frameAt;
  }

  /** Assigning it keeps every fraction and lays the tree with the new frames. */
  set frames(mode: FrameMode) {
    this.frameAt = frameMode(mode);
    this.splitMemo.clear();
    if (this.list.length) this.derive();
  }

  /** Whether a dragged boundary lands on a neighbour it nearly meets. */
  get snap(): SnapMode {
    return this.snapMode;
  }

  set snap(mode: SnapMode) {
    if (mode !== 'merge' && mode !== 'off') return;
    this.snapMode = mode;
  }

  constructor(state?: SoksakState, options: SoksakOptions = {}) {
    // default: each layout option is optional and documented with this default in SoksakOptions.
    this.gap = options.gap ?? 24;
    // default: documented in SoksakOptions.
    const min = options.minSize ?? 96;
    this.min = Number.isFinite(min) && min >= 0 ? min : 96;
    // Every option is checked the same way. A number that is not one puts NaN
    // into every rect the plane computes, and the elements then carry a length
    // the CSSOM discards.
    this.grab = 11;
    // default: documented in SoksakOptions.
    this.grabSize = options.grabSize ?? 11;
    this.snapAt = 7;
    // default: documented in SoksakOptions.
    this.snapDistance = options.snapDistance ?? 7;
    this.snapMode = 'merge';
    // default: documented in SoksakOptions.
    this.snap = options.snap ?? 'merge';
    // default: documented in SoksakOptions.
    this.frameAt = frameMode(options.frames ?? 'corridor');
    // default: documented in SoksakOptions.
    this.w = 0;
    this.h = 0;
    // default: a plane made before its host has a size starts empty; `resize` sets it.
    this.resize(options.width ?? 0, options.height ?? 0);

    if (state) {
      checkState(state);
      this.load(state);
    } else {
      this.derive();
    }
    this.commit();
  }

  static from(state: SoksakState, options?: SoksakOptions): Soksak {
    return new Soksak(state, options);
  }

  // ---- the tree ----------------------------------------------------------

  /** Takes the tree of a state as a copy and derives the lines and the cells. */
  private load(state: SoksakState): void {
    this.root = cloneNode(state.root);
    this.derive();
  }

  /**
   * Lays the tree into the plane and derives the lines and the cells from it
   * (packages/soksak/docs/layout.md#the-model). A cut first takes its fixed costs
   * from its extent, the corridors between its kids and the px sizes of the kids
   * that keep one, and gives every other kid its fraction of the rest, so equal
   * fractions draw equal sizes; a box takes its frames, one corridor on its left,
   * right and bottom, and on its top the head of the host, from the extent of its
   * inner node. A line stands at the middle of each corridor, at its px over the
   * extent of the plane, and coordinates within EPS are one line (R1). Before the
   * plane has a size the tree is laid by its fractions alone. The corridor narrows
   * when the plane cannot hold the gaps, which the lines decide, so the tree is
   * laid again with the corridor that the first lines give.
   */
  private derive(): void {
    const sized = this.w > 0 && this.h > 0;
    let unit = { x: sized ? this.g : 0, y: sized ? this.g : 0 };
    // The corridor of an axis is the gap capped at the extent over the lines and frames that hold one (R5); a cut that still
    // cannot hold its corridors narrows the corridor of its axis by halves, down to none.
    for (let pass = 0; ; pass++) {
      const crowded = this.lay(unit, sized);
      if (!sized) break;
      const capped = pass === 0 ? { ...this.plane, unit: undefined } : null;
      const next = {
        x: capped ? 2 * halfCorridor(capped, 'x') : crowded.x ? (unit.x < 1e-3 ? 0 : unit.x / 2) : unit.x,
        y: capped ? 2 * halfCorridor(capped, 'y') : crowded.y ? (unit.y < 1e-3 ? 0 : unit.y / 2) : unit.y,
      };
      if (next.x === unit.x && next.y === unit.y) break;
      unit = next;
    }
    this.unit = unit;
  }

  /** The px size that a node keeps on an axis whatever its fraction, with its own costs, or null for a node that takes a fraction. */
  private heldOf(node: TreeNode, axis: Axis, unit: Record<Axis, number>): number | null {
    const kept = this.keptOf(node, axis, unit);
    return kept && kept.px + kept.cost;
  }

  /**
   * The px size that a node keeps on an axis in two parts: `px`, the sizes that its cards declare, which a plane that cannot draw
   * them scales, and `cost`, its corridors, frames and heads, which it does not. Null for a node that takes a fraction.
   */
  private keptOf(node: TreeNode, axis: Axis, unit: Record<Axis, number>): { px: number; cost: number } | null {
    if (isCard(node)) {
      const px = axis === 'x' ? node.width : node.height;
      return px === undefined ? null : { px, cost: 0 };
    }
    if (isBox(node)) {
      const inner = this.keptOf(node.inner, axis, unit);
      if (inner === null) return null;
      return { px: inner.px, cost: inner.cost + (axis === 'x' ? 2 * unit.x : unit.y + (this.heads.get(node.box) ?? 0)) };
    }
    const kids = node.kids.map((kid) => this.keptOf(kid.node, axis, unit));
    if (node.cut === axis) {
      // A cut along the axis keeps a px size only when every kid keeps one: their sizes and the corridors between them.
      if (kids.some((kid) => kid === null)) return null;
      return kids.reduce<{ px: number; cost: number }>(
        (a, kid) => ({ px: a.px + (kid as { px: number }).px, cost: a.cost + (kid as { cost: number }).cost }),
        { px: 0, cost: (node.kids.length - 1) * unit[axis] },
      );
    }
    // A cut across the axis keeps the largest size of its kids.
    let most: { px: number; cost: number } | null = null;
    for (const kid of kids) if (kid && (!most || kid.px + kid.cost > most.px + most.cost)) most = kid;
    return most;
  }

  /**
   * The px size of each kid of a cut along its axis, from the room inside the
   * cut (packages/soksak/docs/layout.md#the-model): the corridors between the
   * kids first, then the px sizes of the kids that keep one, and the rest to the
   * other kids by their fractions. A kid gets at least the costs inside it, its
   * own corridors, px sizes, frames and heads, and the others share what is left.
   * A fixed card with a px size is a cost of its level and keeps it while the
   * room holds the costs and one `minSize` for the kids that share; the px sizes
   * of the kids that share are scaled by one factor to leave the kids that take a
   * fraction one `minSize`; when no kid takes a fraction, they divide the room in
   * their proportion. Null when the room does not hold the costs of the kids.
   */
  private kidSizes(node: CutNode, room: number, unit: Record<Axis, number>): number[] | null {
    const axis = node.cut;
    const held = node.kids.map((kid) => this.keptOf(kid.node, axis, unit));
    const costs = node.kids.map((kid, i) => (held[i] === null ? this.costOf(kid.node, axis, unit) : 0));
    // A fixed card with a px size is a cost of its level, as a corridor is: it is no kid that shares.
    const leaf = node.kids.map((kid, i) => held[i] !== null && isCard(kid.node) && kid.node.fixed === true);
    const fixedAsked = held.reduce<number>((a, kept, i) => a + (kept && leaf[i] ? kept.px : 0), 0);
    const asked = held.reduce<number>((a, kept, i) => a + (kept && !leaf[i] ? kept.px : 0), 0);
    // The corridors between the kids and the costs inside the kids that keep a px size are drawn whatever the scale.
    let free = room - (node.kids.length - 1) * unit[axis] - held.reduce<number>((a, kept) => a + (kept?.cost ?? 0), 0);
    if (free < -EPS) return null;
    const sharingAny = held.some((kept) => kept === null);
    const costSum = costs.reduce((a, c) => a + c, 0);
    // The fixed cards keep their px sizes while the room holds them, the corridors and the costs, and one minSize for the kids that share:
    // a corridor or a cost that an operation adds or removes is paid by the kids that share. Only a room that does not hold them scales
    // the fixed cards, by one factor; a cut of fixed cards alone divides the room in their proportion.
    let fixedScale = 1;
    if (fixedAsked > 0) {
      const need = Math.max(this.min, costSum);
      if (!sharingAny && asked === 0) fixedScale = Math.max(0, free) / fixedAsked;
      else if (free - fixedAsked < need) fixedScale = Math.max(0, free - Math.min(need, Math.max(0, free))) / fixedAsked;
    }
    free -= fixedAsked * fixedScale;
    // The px sizes of the kids that share are scaled by one factor, so their proportions survive, to leave the kids that take a fraction
    // one minSize, which does not count the costs inside them; only a room that does not hold those costs scales them further. Without a
    // kid that takes a fraction, they divide the room in their proportion.
    let scale = 1;
    if (asked > 0 && !sharingAny) scale = Math.max(0, free) / asked;
    if (asked > 0 && sharingAny) {
      if (free - asked < this.min) scale = Math.max(0, free - Math.min(this.min, Math.max(0, free))) / asked;
      if (free - asked * scale < costSum) scale = Math.max(0, free - costSum) / asked;
    }
    let rest = free - asked * scale;
    const sizes = node.kids.map((_, i) => {
      const kept = held[i];
      return kept ? kept.px * (leaf[i] ? fixedScale : scale) + kept.cost : 0;
    });
    const open = new Set(node.kids.map((_, i) => i).filter((i) => held[i] === null));
    if (rest < costs.reduce((a, c) => a + c, 0) - EPS) return null;
    // The frames and heads of a kid are fixed costs of the cut: each kid that takes a fraction is drawn its frames and its
    // fraction of what the frames leave, so equal fractions draw equal sizes inside the frames. A kid whose size comes out
    // less than the costs inside it takes those costs, and the others share the rest.
    const frames = node.kids.map((kid) => this.frameOf(kid.node, axis, unit));
    for (;;) {
      const shared = [...open].reduce((a, i) => a + node.kids[i].share, 0);
      const left = rest - [...open].reduce((a, i) => a + frames[i], 0);
      const of = (i: number) => frames[i] + (shared > 0 ? (node.kids[i].share / shared) * Math.max(0, left) : 0);
      let clamped = false;
      for (const i of open) {
        if (of(i) < costs[i] - EPS) {
          sizes[i] = costs[i];
          rest -= costs[i];
          open.delete(i);
          clamped = true;
        }
      }
      if (clamped) continue;
      for (const i of open) sizes[i] = of(i);
      // Without a corridor, a kid of no size would put two lines of the cut at one place and leave a card no cell.
      if (unit[axis] === 0 && sizes.some((size) => size <= EPS * Math.max(1, room))) return null;
      return sizes;
    }
  }

  /**
   * The px of the frames and heads of the boxes that hold a node whole on an axis: a box takes one corridor on each side of x,
   * and on y its head above and one corridor below. They are costs of the cut that holds the node (R5).
   */
  private frameOf(node: TreeNode, axis: Axis, unit: Record<Axis, number>): number {
    if (!isBox(node)) return 0;
    const frame = this.frameIn(unit);
    return this.frameOf(node.inner, axis, unit) + (axis === 'x' ? 2 * frame.x : frame.y + (this.heads.get(node.box) ?? 0));
  }

  /** The px that the frame of a box takes on each axis at the corridor `unit`. */
  private frameIn(unit: Record<Axis, number>): Record<Axis, number> {
    return this.frameAt === 'none' ? { x: 0, y: 0 } : unit;
  }

  /** The px that a node takes on an axis at no size of its cards: its corridors, px sizes, frames and heads. */
  private costOf(node: TreeNode, axis: Axis, unit: Record<Axis, number>): number {
    const held = this.heldOf(node, axis, unit);
    if (held !== null) return held;
    if (isCard(node)) return 0;
    if (isBox(node)) {
      const frame = this.frameIn(unit);
      return this.costOf(node.inner, axis, unit) + (axis === 'x' ? 2 * frame.x : frame.y + (this.heads.get(node.box) ?? 0));
    }
    const kids = node.kids.map((kid) => this.costOf(kid.node, axis, unit));
    if (node.cut !== axis) return Math.max(...kids);
    return kids.reduce((a, c) => a + c, 0) + (node.kids.length - 1) * unit[axis];
  }

  private lay(unit: Record<Axis, number>, sized: boolean): Record<Axis, boolean> {
    const crowded = { x: false, y: false };
    const extentOf = { x: sized ? this.w : 1, y: sized ? this.h : 1 };
    const spots = new Map<TreeNode, Extent>();
    const insets = new Map<TreeNode, Extent>();
    const up = new Map<TreeNode, Holding>();
    const leaves: CardNode[] = [];
    const boxes = new Map<string, BoxNode>();
    const paths = new Map<CardNode | BoxNode, BoxNode[]>();
    const place = (node: TreeNode, slot: Extent, inset: Extent, path: BoxNode[]): void => {
      this.visited++;
      spots.set(node, slot);
      insets.set(node, inset);
      if (isCut(node)) {
        const axis = node.cut;
        const [lo, hi] = ENDS[axis];
        const u = unit[axis];
        const from = slot[lo] + inset[lo];
        const room = slot[hi] - inset[hi] - from;
        const sizes = sized ? this.kidSizes(node, room, unit) : node.kids.map((kid) => kid.share * room);
        if (!sizes) {
          crowded[axis] = true;
        }
        // A cut that cannot hold its corridors at no corridor lays its kids by their fractions alone, so every kid keeps a slot
        // and is drawn at no size.
        const each = sizes ?? node.kids.map((kid) => kid.share * Math.max(room, slot[hi] - slot[lo]));
        let at = sizes ? from : slot[lo];
        let start = slot[lo];
        node.kids.forEach((kid, i) => {
          up.set(kid.node, { node, at: i });
          const size = each[i];
          const last = i === node.kids.length - 1;
          const end = last ? slot[hi] : sizes ? at + size + u / 2 : at + size;
          place(
            kid.node,
            { ...slot, [lo]: start, [hi]: end },
            { ...inset, [lo]: i === 0 ? inset[lo] : u / 2, [hi]: last ? inset[hi] : u / 2 },
            path,
          );
          at += sizes ? size + u : size;
          start = end;
        });
      } else if (isBox(node)) {
        boxes.set(node.box, node);
        paths.set(node, path);
        up.set(node.inner, { node, at: -1 });
        const head = sized ? this.heads.get(node.box) ?? 0 : 0;
        const frame = this.frameIn(unit);
        place(
          node.inner,
          slot,
          { x0: inset.x0 + frame.x, x1: inset.x1 + frame.x, y0: inset.y0 + head, y1: inset.y1 + frame.y },
          [...path, node],
        );
      } else {
        leaves.push(node);
        paths.set(node, path);
      }
    };
    place(this.root, { x0: 0, x1: extentOf.x, y0: 0, y1: extentOf.y }, { x0: 0, x1: 0, y0: 0, y1: 0 }, []);
    const xv: number[] = [];
    const yv: number[] = [];
    const pxOf = new Map<TreeNode, Extent>(spots);
    for (const [node, e] of spots) {
      const unitSlot = { x0: e.x0 / extentOf.x, x1: e.x1 / extentOf.x, y0: e.y0 / extentOf.y, y1: e.y1 / extentOf.y };
      spots.set(node, unitSlot);
      if (isCard(node)) {
        xv.push(unitSlot.x0, unitSlot.x1);
        yv.push(unitSlot.y0, unitSlot.y1);
      }
    }
    this.xs = linesOf(xv);
    this.ys = linesOf(yv);
    // The px position of each line is the px edge that the layout placed there, so a card is drawn at the px sizes that the
    // layout gave it, without the rounding of a fraction of the extent.
    const at = { x: this.xs.map((f) => f * extentOf.x), y: this.ys.map((f) => f * extentOf.y) };
    for (const [node, e] of pxOf) {
      if (!isCard(node)) continue;
      const u = spots.get(node) as Extent;
      at.x[lineOf(this.xs, u.x0)] = e.x0;
      at.x[lineOf(this.xs, u.x1)] = e.x1;
      at.y[lineOf(this.ys, u.y0)] = e.y0;
      at.y[lineOf(this.ys, u.y1)] = e.y1;
    }
    this.linesAt = sized ? at : null;
    this.at = new Map();
    for (const [node, e] of spots) {
      this.at.set(node, [lineOf(this.xs, e.x0), lineOf(this.xs, e.x1), lineOf(this.ys, e.y0), lineOf(this.ys, e.y1)]);
    }
    this.spots = spots;
    this.insets = insets;
    this.up = up;
    this.boxes = boxes;
    this.leaves = new Map();
    this.byId = new Map();
    this.list = leaves.map((leaf) => {
      const [c0, c1, r0, r1] = this.at.get(leaf) as NodeLines;
      // default: `fixed` is optional on a card node; an unmarked card is not fixed.
      const card: Card = { id: leaf.card, c0, c1, r0, r1, fixed: leaf.fixed ?? false };
      if (leaf.data !== undefined) card.data = leaf.data;
      if (leaf.width !== undefined) card.width = leaf.width;
      if (leaf.height !== undefined) card.height = leaf.height;
      this.leaves.set(leaf.card, leaf);
      this.byId.set(leaf.card, card);
      return card;
    });
    // The frames of a card: on its left, right and bottom side the boxes around it that end on the line of that side, each one
    // corridor inside the last (R5); and the heads of the boxes around it that start on its top line.
    const frames = new Map<string, Frames>();
    const above = new Map<string, number>();
    for (const leaf of leaves) {
      const [c0, c1, r0, r1] = this.at.get(leaf) as NodeLines;
      const counts: Frames = { left: 0, right: 0, top: 0, bottom: 0 };
      let heads = 0;
      for (const box of paths.get(leaf) as BoxNode[]) {
        const [b0, b1, s0, s1] = this.at.get(box) as NodeLines;
        if (b0 === c0) counts.left++;
        if (b1 === c1) counts.right++;
        if (s1 === r1) counts.bottom++;
        if (s0 === r0 && sized) heads += this.heads.get(box.box) ?? 0;
      }
      if (this.frameAt === 'corridor' && (counts.left || counts.right || counts.bottom)) frames.set(leaf.card, counts);
      above.set(leaf.card, heads);
    }
    // The heads of the boxes around a box that start on its top line, which are drawn inside its rectangle as inside a card's.
    for (const box of boxes.values()) {
      const r0 = (this.at.get(box) as NodeLines)[2];
      let heads = 0;
      for (const outer of paths.get(box) as BoxNode[]) {
        if ((this.at.get(outer) as NodeLines)[2] === r0 && sized) heads += this.heads.get(outer.box) ?? 0;
      }
      above.set(box.box, heads);
    }
    this.cardFrames = frames;
    this.above = above;
    return crowded;
  }

  /**
   * Writes what the operations of the lines changed back into the tree: the
   * attributes of every card, and the share of every kid of a cut from the
   * coordinates of the lines its rectangle starts and ends at. The structure of
   * the tree stays; then the lines are derived again.
   */
  private commit(): void {
    const moved = this.moved;
    this.moved = false;
    for (const card of this.list) {
      const leaf = this.leaves.get(card.id) as CardNode;
      leaf.fixed = card.fixed;
      if (card.data !== undefined) leaf.data = card.data;
      else delete leaf.data;
      sizeOn(leaf, 'x', card.width ?? null);
      sizeOn(leaf, 'y', card.height ?? null);
    }
    // The fraction of a kid that takes one is its drawn size, its slot less its corridors, frames and heads, over the drawn
    // size of the kids of its cut that take one; a kid that keeps a px size keeps its fraction.
    const push = (node: TreeNode): void => {
      this.visited++;
      if (isCut(node)) {
        const axis = node.cut;
        const a = this.arr(axis);
        const extent = this.size(axis);
        const [lo, hi] = ENDS[axis];
        const sizes = node.kids.map((kid) => {
          if (this.heldOf(kid.node, axis, this.unit) !== null) return null;
          const [from, to] = this.on(kid.node, axis);
          const inset = this.insets.get(kid.node) as Extent;
          return (a[to] - a[from]) * extent - inset[lo] - inset[hi] - this.frameOf(kid.node, axis, this.unit);
        });
        const drawn = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
        const shared = node.kids.reduce((sum, kid, i) => (sizes[i] !== null ? sum + kid.share : sum), 0);
        // A fraction is positive: a kid drawn at no size keeps the fractions of its cut as they are.
        if (drawn > 0 && sizes.every((size) => size === null || size > EPS * drawn)) {
          node.kids.forEach((kid, i) => {
            if (sizes[i] !== null) kid.share = ((sizes[i] as number) / drawn) * shared;
          });
        }
        for (const kid of node.kids) push(kid.node);
      } else if (isBox(node)) {
        push(node.inner);
      }
    };
    if (moved && this.w > 0 && this.h > 0) push(this.root);
    this.derive();
  }

  /** The lines on an axis at which the rectangle of a node starts and ends, as the last derive laid it. */
  private on(node: TreeNode, axis: Axis): [number, number] {
    const [c0, c1, r0, r1] = this.at.get(node) as NodeLines;
    return axis === 'x' ? [c0, c1] : [r0, r1];
  }

  /** Puts `next` where `node` stands: in its cut, inside its box, or as the root. A cut along the axis of its cut gives that cut its kids. */
  private put(node: TreeNode, next: TreeNode): void {
    const holding = this.up.get(node);
    if (!holding) {
      this.root = next;
      return;
    }
    const { node: holder, at } = holding;
    if (isBox(holder)) {
      holder.inner = next;
    } else if (isCut(next) && next.cut === holder.cut) {
      const share = holder.kids[at].share;
      holder.kids.splice(at, 1, ...next.kids.map((kid) => ({ share: share * kid.share, node: kid.node })));
    } else {
      holder.kids[at].node = next;
    }
  }



  /** The node that leaves with the card of `leaf`: the card, or the box around it that holds nothing else. */
  private departing(leaf: TreeNode): TreeNode {
    let node = leaf;
    for (let holding = this.up.get(node); holding && holding.at < 0; holding = this.up.get(node)) node = holding.node;
    return node;
  }

  /** Whether an id names a card or a box of the tree. */
  private taken(id: string): boolean {
    return this.byId.has(id) || this.boxes.has(id);
  }

  /**
   * Runs a public operation and counts the nodes that it visits in `visits`;
   * an operation that another runs adds to the count of the outer one.
   */
  private run<T>(body: () => T): T {
    if (this.depth === 0) this.visited = 0;
    this.depth++;
    try {
      return body();
    } finally {
      this.depth--;
    }
  }

  /**
   * The number of nodes of the tree that the last operation visited
   * (packages/soksak/docs/layout.md#cuts). Every operation is linear in the
   * nodes that it touches, so a test bounds this count on a large tree.
   */
  get visits(): number {
    return this.visited;
  }

  /**
   * Sets the px that the host draws inside the top of each box by id, above its
   * inner node, which the drawn sizes and the minimum of the cut operations
   * count. The heads are no part of the state. Throws for an id that is no box
   * and for a head that is no finite number from zero, and then changes nothing.
   */
  setHeads(heads: Readonly<Record<string, number>>): void {
    const next = new Map<string, number>();
    for (const [id, px] of Object.entries(heads)) {
      if (!this.boxes.has(id)) throw new Error(`soksak: heads name ${JSON.stringify(id)}, which is no box`);
      if (!Number.isFinite(px) || px < 0) throw new Error(`soksak: the head of ${JSON.stringify(id)} is ${String(px)}`);
      next.set(id, px);
    }
    this.heads = next;
    this.derive();
  }

  // ---- the plane ---------------------------------------------------------

  resize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      return;
    }
    this.w = width;
    this.h = height;
    this.splitMemo.clear();      // plane size changes the answer
    // The fractions stay, and the tree is laid into the new extent.
    if (this.list.length) this.derive();
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  /**
   * Every card, as frozen copies.
   *
   * Writes to the returned objects do not affect the grid. Use `setFixed`,
   * `setSize` and `setData` to change a card.
   */
  get cards(): readonly Card[] {
    return this.list.map((c) => Object.freeze({ ...c }));
  }

  card(id: string): Card | undefined {
    const found = this.find(id);
    return found && Object.freeze({ ...found });
  }

  /**
   * Replace the payload of a card or a box.
   *
   * `data` is opaque to this library.
   */
  setData(id: string, data: unknown): boolean {
    const box = this.boxes.get(id);
    if (box) {
      box.data = data;
      return true;
    }
    const card = this.find(id);
    if (!card) return false;
    card.data = data;
    (this.leaves.get(id) as CardNode).data = data;
    return true;
  }

  /**
   * The frames of each card by id (R5): on each side the boxes around it that
   * end on the line of that side, which `derive` reads from the tree.
   */
  private cardFrames: ReadonlyMap<string, Frames> = new Map();

  /**
   * Set whether the layout may split, close or move a card.
   */
  setFixed(id: string, fixed: boolean): boolean {
    const card = this.find(id);
    if (!card) return false;
    card.fixed = fixed;
    (this.leaves.get(id) as CardNode).fixed = fixed;
    // splitMemo was computed with the previous `fixed` value. A fixed card never
    // fills for a closing neighbour, so the results change.
    this.splitMemo.clear();
    return true;
  }

  /**
   * Sets a card's px width or height. `null` removes the size and the card takes
   * a share of the remainder.
   *
   * The size belongs to the card in the tree, so the cells that the lines of
   * other cuts draw across it do not change it. Returns false for an unknown
   * axis or a negative or non-finite size.
   */
  setSize(id: string, axis: Axis, px: number | null): boolean {
    if (this.noAxis(axis)) return false;
    const card = this.find(id);
    if (!card) return false;
    if (px !== null && (!Number.isFinite(px) || px < 0)) return false;
    if (axis === 'x') {
      if (px === null) delete card.width;
      else card.width = px;
    } else if (px === null) delete card.height;
    else card.height = px;

    this.changed();
    return true;
  }

  /** The card itself, for the operations that change it. */
  private find(id: string): Card | undefined {
    return this.byId.get(id);
  }

  /** Grid line coordinates, normalised 0..1. A copy — the arrangement owns them. */
  lines(axis: Axis): number[] {
    if (this.noAxis(axis)) return [];
    return [...(axis === 'x' ? this.xs : this.ys)];
  }

  /** The state: a copy of the slicing tree. */
  toJSON(): SoksakState {
    return { root: cloneNode(this.root) };
  }

  /**
   * Replace the arrangement while keeping this grid's plane and options.
   *
   * The payload is opaque to the library. This is the synchronization point
   * for a host that owns the canonical state and keeps one DOM view alive.
   */
  replace(state: SoksakState): void {
    checkState(state);
    this.reload(state);
  }

  /** Puts a state into the grid that `checkState` accepted or that `toJSON` of this grid returned. */
  private reload(state: SoksakState): void {
    this.load(state);
    this.splitMemo.clear();
    this.commit();
  }

  private get plane(): Plane {
    return {
      xs: this.xs, ys: this.ys, cards: this.list, width: this.w, height: this.h, gap: this.gap, minSize: this.min,
      frames: this.cardFrames, unit: this.w > 0 && this.h > 0 ? this.unit : undefined,
      at: this.moved || !this.linesAt ? undefined : this.linesAt,
    };
  }

  private arr(axis: Axis): number[] {
    return axis === 'x' ? this.xs : this.ys;
  }

  /** Rejects an axis value the caller invented. Every public method that takes one checks it. */
  private noAxis(axis: Axis): boolean {
    return axis !== 'x' && axis !== 'y';
  }

  private size(axis: Axis): number {
    return axis === 'x' ? this.w : this.h;
  }

  // ---- reading the arrangement -------------------------------------------

  rectOf(card: Card): Rect {
    return rectOf(this.plane, card);
  }

  /**
   * The drawn rectangle of the card or the box id: a box is drawn between its lines, each inset by its corridor and by the
   * frames of the boxes around it, so its frame and its head stand inside it (R5); the heads of the boxes around it that start
   * on its top line are drawn inside its top, as inside the top of a card.
   */
  rect(id: string): Rect | undefined {
    const card = this.find(id);
    if (card) return this.rectOf(card);
    const box = this.boxes.get(id);
    if (!box) return undefined;
    const at = (axis: Axis, line: number) => this.boundaryPos(axis, line);
    const [c0, c1, r0, r1] = this.at.get(box) as NodeLines;
    const inset = this.insets.get(box) as Extent;
    const x = at('x', c0) + inset.x0;
    const y = at('y', r0) + inset.y0 - (this.above.get(id) ?? 0);
    return { x, y, w: Math.max(0, at('x', c1) - inset.x1 - x), h: Math.max(0, at('y', r1) - inset.y1 - y) };
  }

  /** The px of the heads of the boxes around the card or the box `id` that the grid draws inside the top of its rectangle. */
  headsAbove(id: string): number {
    return this.above.get(id) ?? 0;
  }

  rects(): Map<string, Rect> {
    const frame = frameOf(this.plane);        // measured once, not once per card
    return new Map(this.list.map((c) => [c.id, rectIn(frame, c)]));
  }

  /**
   * Where a drop lands — which card, and whether on it or beside it.
   *
   * The point is in the plane's own coordinates, the ones `rects()` reports.
   */
  zoneAt(x: number, y: number, options: ZoneOptions = {}): ZoneHit | null {
    return zoneAt(this.plane, x, y, options);
  }

  /** Cards that span across a line, as frozen copies. They are what a card placed on it would cut. */
  cardsCrossing(axis: Axis, line: number): readonly Card[] {
    if (this.noAxis(axis)) return [];
    return crossing(this.plane, axis, line).map((c) => Object.freeze({ ...c }));
  }

  /** How many lines a card spans across — how much finer its neighbours are. */
  crossings(card: Card): number {
    return Math.max(0, card.c1 - card.c0 - 1) + Math.max(0, card.r1 - card.r0 - 1);
  }

  // ---- boundaries --------------------------------------------------------

  /**
   * Draws `node`, which keeps a px size on `axis`, `delta` px larger at the edge `side` that a seam moves: a card takes the
   * delta at the scale it is drawn at, a box gives it to its inner node, a cut along the axis to its kid at that edge, and a cut
   * across it to each of its kids that keeps a size.
   */
  private grow(node: TreeNode, axis: Axis, delta: number, side: 'start' | 'end'): void {
    if (isBox(node)) return this.grow(node.inner, axis, delta, side);
    if (isCut(node)) {
      const kids = node.cut === axis ? [side === 'end' ? node.kids[node.kids.length - 1] : node.kids[0]] : node.kids;
      for (const kid of kids) if (this.heldOf(kid.node, axis, this.unit) !== null) this.grow(kid.node, axis, delta, side);
      return;
    }
    const card = this.byId.get(node.card) as Card;
    const own = fixedSize(card, axis);
    if (own === null) return;
    const now = this.input().content(node, axis);
    // The new content over the drawn content is the scale of the declaration; a card drawn at its size takes the delta as it is.
    this.declareOn(axis, card, Math.max(0, now > EPS ? (Math.abs(now - own) < 1e-6 ? own + delta : (own * (now + delta)) / now) : own + delta));
  }

  /** Declares the px size `size` of the card on `axis`. */
  private declareOn(axis: Axis, card: Card, size: number): void {
    if (axis === 'x') card.width = size;
    else card.height = size;
  }


  /** Everything to draw for the boundaries. */
  rules(): Rule[] {
    return rules(this.plane);
  }

  dividers(): Divider[] {
    return dividers(this.plane, this.grabSize);
  }

  /** Where a boundary is now, in px along its axis. */
  boundaryPos(axis: Axis, line: number): number {
    if (this.noAxis(axis) || !Number.isInteger(line)) return 0;
    const along = linePositions(this.plane, axis);
    return line >= 0 && line < along.length ? along[line] : 0;
  }

  /**
   * Whether `line` is an interior line index.
   *
   * Index 0 and the last index are the plane's borders and are not boundaries.
   */
  hasBoundary(axis: Axis, line: number): boolean {
    if (this.noAxis(axis)) return false;
    return Number.isInteger(line) && line >= 1 && line <= this.arr(axis).length - 2;
  }

  /**
   * The px range a boundary may move within while every card keeps `minSize`.
   *
   * The range extends to the neighbouring lines, each the edge of a card. When the cards on both sides need more than the plane
   * holds, `lo` and `hi` are equal rather than inverted.
   *
   * The range always contains the position the boundary stands at, so a drag
   * that does not move it changes nothing.
   *
   * A boundary with a px size on exactly one side of it, on an axis the plane
   * cannot hold, reports the position it stands at twice: every way of moving it
   * changes the size a card that does not meet it is drawn at. The declared
   * sizes are scaled by one factor there, so changing one changes them all, and
   * the sharing slots always divide the same remainder between them.
   */
  boundaryRange(axis: Axis, line: number): [number, number] {
    if (this.noAxis(axis)) return [0, 0];
    // The same line every other boundary method takes. Without this the two
    // neighbours below fall back to the plane's borders and the method answers a
    // range for a line that has no boundary.
    if (!this.hasBoundary(axis, line)) return [0, 0];
    if (!holdsSizes(this.plane, axis)) {
      const declared = heldSizes(this.plane, axis);
      if ((declared[line - 1] !== null) !== (declared[line] !== null)) {
        const at = this.boundaryPos(axis, line);
        return [at, at];
      }
    }
    // The boundary is the seams of the cuts along the axis that stand on the line, and a drag moves every one of them. Each
    // seam bounds the move by the two kids of its own cut: each can give what it can lose before a card inside it is drawn
    // below its minimum. A line of another cut is no limit, because the kids of another cut do not change.
    const now = this.rects();
    const { extentOf, need } = this.measure(now, now);
    const input = this.input();
    const drawn = (node: TreeNode) => {
      const e = extentOf(node);
      return axis === 'x' ? e.x1 - e.x0 : e.y1 - e.y0;
    };
    // What a node can lose on the axis: a card or a node that keeps a px size down to its minimum; a cut across the axis loses
    // it in every kid; a cut along it shares the loss among its kids that take a fraction in proportion to their contents.
    const loses = (node: TreeNode): number => {
      if (isBox(node)) return loses(node.inner);
      // A drag sets the size of a card that the person moves, a fixed card or one that declares a px size included, so a card
      // can lose down to `minSize` and the heads inside it.
      if (isCard(node)) return Math.max(0, drawn(node) - this.min - (axis === 'y' ? this.above.get(node.card) ?? 0 : 0));
      if (!isCut(node) || this.heldOf(node, axis, this.unit) !== null) return Math.max(0, drawn(node) - need(node, axis));
      if (node.cut !== axis) return Math.min(...node.kids.map((kid) => loses(kid.node)));
      const open = node.kids.filter((kid) => this.heldOf(kid.node, axis, this.unit) === null);
      const total = open.reduce((a, kid) => a + input.content(kid.node, axis), 0);
      let most = Infinity;
      for (const kid of open) {
        const part = input.content(kid.node, axis);
        if (part > EPS) most = Math.min(most, (loses(kid.node) * total) / part);
      }
      return most === Infinity ? 0 : most;
    };
    const at = this.boundaryPos(axis, line);
    let toward = Infinity;
    let away = Infinity;
    for (const { cut, i } of this.seams(axis, line)) {
      toward = Math.min(toward, loses(cut.kids[i].node));
      away = Math.min(away, loses(cut.kids[i + 1].node));
    }
    if (toward === Infinity) return [at, at];
    return [at - toward, at + away];
  }

  /** The seams of the cuts along `axis` that stand on the derived line `line`: each cut and the index of the kid before the seam. */
  private seams(axis: Axis, line: number): { cut: CutNode; i: number }[] {
    const end = axis === 'x' ? 1 : 3;
    const out: { cut: CutNode; i: number }[] = [];
    const visit = (node: TreeNode): void => {
      this.visited++;
      if (isBox(node)) return visit(node.inner);
      if (!isCut(node)) return;
      if (node.cut === axis) {
        for (let i = 0; i < node.kids.length - 1; i++) {
          if ((this.at.get(node.kids[i].node) as NodeLines)[end] === line) out.push({ cut: node, i });
        }
      }
      for (const kid of node.kids) visit(kid.node);
    };
    visit(this.root);
    return out;
  }

  /**
   * Move a boundary to a position in px.
   *
   * When either adjacent slot has a px size, that size changes. Otherwise the
   * line itself moves and every card referencing it moves with it.
   *
   * Returns the resulting position.
   */
  moveBoundary(axis: Axis, line: number, px: number, allowSnap = true): number {
    if (this.noAxis(axis)) return 0;
    return this.run(() => this.moveLine(axis, line, px, allowSnap));
  }

  /** `moveBoundary` of an axis that is one. */
  private moveLine(axis: Axis, line: number, px: number, allowSnap: boolean): number {
    if (!this.hasBoundary(axis, line) || !Number.isFinite(px)) return this.boundaryPos(axis, line);
    const [min, max] = this.boundaryRange(axis, line);
    let target = clamp(px, min, max);

    if (allowSnap && this.snap !== 'off') {
      const along = linePositions(this.plane, axis);
      for (const edge of [along[line - 1], along[line + 1]]) {
        if (edge >= min - EPS && edge <= max + EPS && Math.abs(target - edge) < this.snapDistance) {
          target = edge;
        }
      }
    }

    // A move to where the boundary stands changes nothing, a declared size that the plane draws scaled included.
    if (Math.abs(target - this.boundaryPos(axis, line)) < 1e-9) return this.boundaryPos(axis, line);
    // Each seam on the line moves by the same px. The contents of the kids of each cut are read before anything changes: the
    // kid before the seam is drawn `off` larger and the kid after it `off` smaller, and every other kid keeps its content. A kid
    // that keeps a px size takes the new size at the scale it is drawn at, so a plane that draws its declared sizes scaled keeps
    // its scale; the kids that take a fraction take the fractions of their new contents.
    const off = target - this.boundaryPos(axis, line);
    const seams = this.seams(axis, line);
    const kept = this.toJSON();
    const input = this.input();
    const contents = seams.map(({ cut }) => cut.kids.map((kid) => input.content(kid.node, axis)));
    const held = seams.map(({ cut }) => cut.kids.map((kid) => this.heldOf(kid.node, axis, this.unit) !== null));
    seams.forEach(({ cut, i }, k) => {
      if (held[k][i]) this.grow(cut.kids[i].node, axis, off, 'end');
      if (held[k][i + 1]) this.grow(cut.kids[i + 1].node, axis, -off, 'start');
      const want = contents[k].slice();
      want[i] += off;
      want[i + 1] -= off;
      const open = cut.kids.map((_, n) => (held[k][n] ? -1 : n)).filter((n) => n >= 0);
      const shared = open.reduce((a, n) => a + cut.kids[n].share, 0);
      const pool = open.reduce((a, n) => a + Math.max(0, want[n]), 0);
      if (pool <= EPS) return;
      for (const n of open) cut.kids[n].share = (Math.max(0, want[n]) / pool) * shared;
    });
    this.changed();
    // A move that leaves a card with no area changes nothing: the range lets a card reach `minSize`, and a `minSize` of 0 is
    // no area.
    if (!this.hasArea()) {
      this.restore(kept);
      return this.boundaryPos(axis, line);
    }
    // The seam keeps its cut, and the line it now stands on can have another index.
    const first = seams[0];
    return first ? this.boundaryPos(axis, (this.at.get(first.cut.kids[first.i].node) as NodeLines)[axis === 'x' ? 1 : 3]) : this.boundaryPos(axis, line);
  }

  /** px per unit of normalised span across the sharing slots. */
  private sharedExtent(axis: Axis): number {
    return sharePerSpan(this.plane, axis);
  }

  /**
   * Moves a boundary so the two cards beside it are drawn at the same size.
   *
   * A move between two declared sizes keeps their sum, so a plane that draws
   * them scaled keeps its scale, and a move between sharing cards lands where it
   * is asked: one move reaches the middle.
   */
  centerBoundary(axis: Axis, line: number): number {
    if (this.noAxis(axis)) return 0;
    if (!this.hasBoundary(axis, line)) return this.boundaryPos(axis, line);
    // A move lands where it is asked inside the range of the boundary, and the outer edges of the two cards beside the line
    // stay, so one move reaches the middle.
    return this.run(() => this.moveLine(axis, line, this.middleOf(axis, line), false));
  }

  /**
   * Replaces the arrangement with an equal grid of the cards in reading order,
   * and removes every split and merge (packages/soksak/docs/layout.md#even-arrangement).
   * The grid has `rows * columns` equal to the card count `n` or `n + 1`; one
   * empty card is added when `n + 1` is chosen. Among the grids whose cells are at
   * least `minSize` on both axes, the one whose cell is closest to square is taken,
   * and a tie goes to the grid without an empty card. Returns false, and changes
   * nothing, when no grid keeps every cell at least `minSize`.
   */
  arrange(mode: 'even'): boolean {
    if (mode !== 'even') throw new Error(`unknown arrangement "${String(mode)}"`);
    return this.run(() => {
      const n = this.list.length;
      if (n === 0) return false;
      // The drawn size of a card along an axis with `count` cells: the corridors between the cells are costs of the cut, and
      // each cell takes one equal fraction of the rest.
      const cellSize = (count: number, size: number): number => (size - (count - 1) * this.gap) / count;
      let best: { rows: number; columns: number; empty: number; skew: number } | null = null;
      for (let rows = 1; rows <= n + 1; rows++) {
        const columns = Math.ceil(n / rows);
        const empty = rows * columns - n;
        if (empty > 1) continue;
        const cellW = cellSize(columns, this.w);
        const cellH = cellSize(rows, this.h);
        if (cellW < this.min || cellH < this.min) continue;
        const skew = Math.abs(Math.log(cellW / cellH));
        const better =
          !best ||
          skew < best.skew - 1e-9 ||
          (Math.abs(skew - best.skew) <= 1e-9 && empty < best.empty);
        if (better) best = { rows, columns, empty, skew };
      }
      if (!best) return false;
      const { rows, columns, empty } = best;
      // Every cell has one fraction, so every cell is drawn at one size.
      const cutOf = (axis: Axis, kids: TreeNode[]): TreeNode =>
        kids.length === 1 ? kids[0] : { cut: axis, kids: kids.map((node) => ({ share: 1 / kids.length, node })) };
      // The cards fill the grid in reading order: by the line their rectangle starts at, the top first, then the left.
      const reading = [...this.list].sort((p, q) => p.r0 - q.r0 || p.c0 - q.c0);
      const cards: TreeNode[] = reading.map((card) => {
        const leaf = cloneNode(this.leaves.get(card.id) as CardNode) as CardNode;
        delete leaf.width;
        delete leaf.height;
        return leaf;
      });
      for (let k = 0; k < empty; k++) cards.push({ card: this.nextId(), fixed: false });
      // Every line crosses the plane, and the tree takes the cut along x outside.
      const columnNodes: TreeNode[] = [];
      for (let c = 0; c < columns; c++) {
        const column: TreeNode[] = [];
        for (let r = 0; r < rows; r++) column.push(cards[r * columns + c]);
        columnNodes.push(cutOf('y', column));
      }
      this.reload({ root: cutOf('x', columnNodes) });
      return true;
    });
  }

  /**
   * ADD (packages/soksak/docs/layout.md#add-and-remove): adds `node`, a new card
   * `{card, data?}` or what `withdraw` returned, beside `target` toward `side`
   * and returns its id. `target` is an id or the ids that neighbouring kids of
   * one cut hold. Throws its refusal, a result below a minimum included, and
   * changes nothing.
   */
  insert(target: string | readonly string[], side: Side, node: TreeNode): string {
    return this.run(() => {
      this.byCuts((input) => insertNode(input, target, side, node));
      return isBox(node) ? node.box : (node as CardNode).card;
    });
  }

  /**
   * Whether `target` and `side` name the vacated slot of the node `id`, a card or a box (docs/spec/groups.md#vacated-slot): the node
   * itself, or the kid beside it in its cut with the side toward it, named by its id or by the members of a cut. A move there is no
   * change.
   */
  vacates(id: string, target: string | readonly string[], side: string): boolean {
    return vacatesNode(this.input(), id, target, side);
  }

  /**
   * EXCHANGE (packages/soksak/docs/layout.md#add-and-remove): puts the node `a`,
   * a card or a box, where the node `b` stands and `b` where `a` stood. Each
   * place keeps its fraction and the px size that a card there declares, and
   * every other node keeps its rectangle. Throws its refusal, a result below a
   * minimum included, and changes nothing.
   */
  exchange(a: string, b: string): void {
    this.run(() => {
      this.byCuts((input) => exchangeNodes(input, a, b));
    });
  }

  /**
   * REMOVE (packages/soksak/docs/layout.md#add-and-remove): takes the node `id`,
   * a card or a box, out of its cut; the other kids that are no fixed card take
   * its fraction by one factor. Returns the node that left, which `insert` takes.
   * Throws its refusal and changes nothing.
   */
  withdraw(id: string): TreeNode {
    return this.run(() => {
      let left: TreeNode | null = null;
      this.byCuts((input) => {
        const out = withdrawNode(input, id, this.list);
        left = out.left;
        return out.root;
      });
      return left as unknown as TreeNode;
    });
  }

  /**
   * The group split of the card or box `target` (packages/soksak/docs/layout.md#add-and-remove): the box `init.box` with the payload
   * `init.data` and a head of `init.head` px takes the place of `target` in its cut, with its fraction, and its inner node is a cut of two
   * halves along the axis of `side` that holds `target` and `node` toward `side`. The result is judged once with the head and the frames of
   * the new box, so a refusal names the deepest node that the group would draw below its minimum. Throws its refusal and changes nothing.
   */
  group(target: string, side: Side, node: TreeNode, init: { box: string; data?: unknown; head: number }): void {
    this.run(() => {
      if (!node || typeof node !== 'object' || isCut(node) || !(isBox(node) ? node.box : node.card)) {
        throw new Error('soksak: a group takes a card or a box node');
      }
      if (!init.box) throw new Error('soksak: a group names no box');
      if (!Number.isFinite(init.head) || init.head < 0) throw new Error(`soksak: the head of ${JSON.stringify(init.box)} is ${String(init.head)}`);
      const heads = this.heads;
      try {
        this.byCuts((input) => {
          const root = groupNode(input, target, side, node, init.box, init.data);
          this.heads = new Map(heads).set(init.box, init.head);
          return root;
        });
      } catch (error) {
        this.heads = heads;
        this.derive();
        throw error;
      }
    });
  }

  /**
   * Takes the box `id` out of the tree (packages/soksak/docs/layout.md#add-and-remove): its inner node takes its place in its cut, and a
   * cut along the axis of that cut joins it with every kid drawn at the size it had. The head of the box leaves with it. Throws its refusal
   * and changes nothing.
   */
  unwrap(id: string): void {
    this.run(() => {
      if (!this.boxes.has(id)) {
        if (this.leaves.has(id)) throw new Error(`card ${id} is no box`);
        throw new Error(`card ${id} is not a member of the layout`);
      }
      const heads = this.heads;
      try {
        this.byCuts((input) => {
          const root = unwrapNode(input, id);
          const next = new Map(heads);
          next.delete(id);
          this.heads = next;
          return root;
        });
      } catch (error) {
        this.heads = heads;
        this.derive();
        throw error;
      }
    });
  }

  /** Gives the kids of every cut that take a fraction equal fractions (packages/soksak/docs/layout.md#cuts). */
  even(): void {
    this.run(() => this.byCuts((input) => evenCuts(input)));
  }

  /** Whether a node keeps its size on an axis whatever its fraction: a fixed card, or a node drawn at a px size there. */
  private keeps(node: TreeNode, axis: Axis): boolean {
    return (isCard(node) && node.fixed === true) || this.heldOf(node, axis, this.unit) !== null;
  }

  /**
   * A fixed card without a px size on the axis of its cut is a fixed cost of that cut
   * (packages/soksak/docs/layout.md#the-model): after an operation it is drawn at the size it had before, and the kids that take a
   * fraction share the rest in the ratio of their fractions. Its fraction is the one that draws that size.
   */
  private keepFixed(before: Map<string, Rect>): void {
    let changed = false;
    const visit = (node: TreeNode): void => {
      if (isBox(node)) return visit(node.inner);
      if (!isCut(node)) return;
      const axis = node.cut;
      const sharing = node.kids.filter((kid) => this.heldOf(kid.node, axis, this.unit) === null);
      const fixed = sharing.filter((kid) => isCard(kid.node) && kid.node.fixed === true && before.has(kid.node.card));
      if (fixed.length && fixed.length < sharing.length) {
        const drawn = (kid: { node: TreeNode }) => this.input().content(kid.node, axis);
        const rest = sharing.reduce((a, kid) => a + drawn(kid), 0);
        const want = fixed.map((kid) => {
          const was = before.get((kid.node as CardNode).card) as Rect;
          return axis === 'x' ? was.w : was.h;
        });
        const kept = want.reduce((a, size) => a + size, 0);
        const others = sharing.filter((kid) => !fixed.includes(kid)).reduce((a, kid) => a + kid.share, 0);
        if (rest > kept + EPS && others > 0 && fixed.some((kid, i) => Math.abs(drawn(kid) - want[i]) > 1e-9)) {
          const total = (others * rest) / (rest - kept);
          fixed.forEach((kid, i) => {
            kid.share = (total * want[i]) / rest;
          });
          // The shares of a cut sum to one; one factor on all of them keeps every ratio and so every drawn size.
          const sum = node.kids.reduce((a, kid) => a + kid.share, 0);
          for (const kid of node.kids) kid.share /= sum;
          changed = true;
        }
      }
      for (const kid of node.kids) visit(kid.node);
    };
    visit(this.root);
    if (changed) {
      this.derive();
      this.changed();
    }
  }

  /** What an operation of the cuts reads of the grid, on the stored tree itself. */
  private input(): Input {
    return {
      root: this.root,
      taken: (id) => this.taken(id),
      keeps: (node, axis) => this.keeps(node, axis),
      content: (node, axis) => {
        const [lo, hi] = ENDS[axis];
        const slot = this.spots.get(node);
        const inset = this.insets.get(node);
        if (!slot || !inset) return this.heldOf(node, axis, this.unit) ?? 0;
        // A node that takes a fraction is drawn its frames and its fraction of the rest; its content is that rest.
        const frames = this.heldOf(node, axis, this.unit) === null ? this.frameOf(node, axis, this.unit) : 0;
        return (slot[hi] - slot[lo]) * this.size(axis) - inset[lo] - inset[hi] - frames;
      },
      corridor: (axis) => this.unit[axis],
      frame: (node, axis) => this.frameOf(node, axis, this.unit),
      visit: () => {
        this.visited++;
      },
    };
  }

  /**
   * Installs the stored tree that `make` makes of the stored tree and lays it. A
   * result that draws a node that it changed below its minimum throws its text.
   * A throw puts the arrangement back.
   */
  private byCuts(make: (input: Input) => TreeNode): void {
    const kept = this.toJSON();
    const before = this.rects();
    try {
      this.root = make(this.input());
      this.derive();
      this.changed();
      this.keepFixed(before);
      const below = this.belowMinimum(before);
      if (below) throw new Error(below);
    } catch (error) {
      this.restore(kept);
      throw error;
    }
  }

  /**
   * The drawn extent of a node, the extent of the drawn rectangles of its cards, and its recursive minimum on an axis
   * (packages/soksak/docs/layout.md#cuts), read from the rectangles `now`; `before` holds the rectangles that a fixed card had.
   */
  private measure(now: Map<string, Rect>, before: Map<string, Rect>): { extentOf: (node: TreeNode) => Extent; need: (node: TreeNode, axis: Axis) => number } {
    const extentOf = (node: TreeNode): Extent => {
      const all = cardsOf(node).map((leaf) => now.get(leaf.card) as Rect);
      return {
        x0: Math.min(...all.map((r) => r.x)),
        x1: Math.max(...all.map((r) => r.x + r.w)),
        y0: Math.min(...all.map((r) => r.y)),
        y1: Math.max(...all.map((r) => r.y + r.h)),
      };
    };
    const along = (e: Extent, axis: Axis) => (axis === 'x' ? e.x1 - e.x0 : e.y1 - e.y0);
    const need = (node: TreeNode, axis: Axis): number => {
      this.visited++;
      if (isBox(node)) return need(node.inner, axis);
      if (isCard(node)) {
        const heads = axis === 'y' ? this.above.get(node.card) ?? 0 : 0;
        const px = axis === 'x' ? node.width : node.height;
        // A fixed card with a px size is drawn no smaller than its size, or than the size it had where the plane drew it smaller.
        if (node.fixed && px !== undefined) {
          const was = before.get(node.card);
          return Math.min(px, was ? (axis === 'x' ? was.w : was.h) : px);
        }
        if (node.fixed) return along(extentOf(node), axis);
        // A card with a px size below `minSize` needs that size: it is drawn at it while the plane holds the sizes.
        if (px !== undefined) return Math.min(px, this.min) + heads;
        return this.min + heads;
      }
      const kids = node.kids.map((kid) => need(kid.node, axis));
      if (node.cut !== axis) return Math.max(...kids);
      const corridors = along(extentOf(node), axis) - node.kids.reduce((a, kid) => a + along(extentOf(kid.node), axis), 0);
      return kids.reduce((a, n) => a + n, 0) + corridors;
    };
    return { extentOf, need };
  }

  /**
   * The text of the deepest node whose drawn rectangle the last operation
   * changed and that is drawn below its minimum, or null: the first such node in
   * the depth-first order of the tree, a box after the nodes inside it. The
   * rectangle of a card is its own, that of a box the extent of the cards inside
   * it. The minimum of a node is recursive: a card
   * needs `minSize` and on y the heads drawn inside its rectangle, a card that
   * keeps a px size the smaller of that size and `minSize`, a fixed card with a
   * px size the smaller of that size and the size it had, another fixed card the
   * size it is drawn at, a box the minimum of its
   * inner node, a cut along an axis the minimums of its kids and the corridors
   * between them, and a cut across it the largest minimum of its kids.
   */
  private belowMinimum(before: Map<string, Rect>): string | null {
    const now = this.rects();
    const { extentOf, need } = this.measure(now, before);
    const text = (n: number) => String(Math.round(n));
    // Only a node whose rectangle changes is judged (docs/spec/groups.md#minimum-size): a card by its rectangle, and a box by the extent
    // of the cards inside it, which a change of a card inside it that keeps that extent leaves as it was.
    const moved = (node: TreeNode): boolean => {
      if (isCard(node)) {
        const was = before.get(node.card);
        const is = now.get(node.card) as Rect;
        return !was || Math.abs(was.x - is.x) > 1e-6 || Math.abs(was.y - is.y) > 1e-6 || Math.abs(was.w - is.w) > 1e-6
          || Math.abs(was.h - is.h) > 1e-6;
      }
      const was: Extent = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (const leaf of cardsOf(node)) {
        const r = before.get(leaf.card);
        if (!r) continue;
        was.x0 = Math.min(was.x0, r.x);
        was.x1 = Math.max(was.x1, r.x + r.w);
        was.y0 = Math.min(was.y0, r.y);
        was.y1 = Math.max(was.y1, r.y + r.h);
      }
      const is = extentOf(node);
      return Math.abs(was.x0 - is.x0) > 1e-6 || Math.abs(was.x1 - is.x1) > 1e-6 || Math.abs(was.y0 - is.y0) > 1e-6
        || Math.abs(was.y1 - is.y1) > 1e-6;
    };
    // The deepest node below its minimum names the refusal, because the minimum of a box or a cut is the sum of the minimums
    // inside it: a box is below its minimum where a node inside it is, and the node inside it is the one that has no room.
    const visit = (node: TreeNode): string | null => {
      if (isCut(node)) {
        for (const kid of node.kids) {
          const found = visit(kid.node);
          if (found) return found;
        }
        return null;
      }
      if (isBox(node)) {
        const found = visit(node.inner);
        if (found) return found;
      }
      if (!moved(node)) return null;
      const has = extentOf(node);
      const w = has.x1 - has.x0;
      let h = has.y1 - has.y0;
      const nx = need(node, 'x');
      let ny = need(node, 'y');
      if (w >= nx - 0.5 && h >= ny - 0.5) return null;
      // A card is named at the size of its content, the heads drawn inside the top of its rectangle taken out of what it has
      // and of what it needs.
      if (isCard(node)) {
        h -= this.above.get(node.card) ?? 0;
        ny -= this.above.get(node.card) ?? 0;
      }
      return `card ${isBox(node) ? node.box : node.card} would be ${text(w)}x${text(h)}, below its minimum ${text(nx)}x${text(ny)}`;
    };
    return visit(this.root);
  }

  /**
   * Where the two cards meeting at a boundary come out the same size.
   *
   * This is not the midpoint of the two lines: a card at the plane's border
   * insets on one side only.
   */
  private middleOf(axis: Axis, line: number): number {
    // hasBoundary is true, so the line has one on each side of it.
    const along = linePositions(this.plane, axis);
    const [lo, hi] = SPAN[axis];
    const near = this.plane;
    const seen = linesRead(near, axis);
    // The pair is the innermost one: of the cards ending here the one that starts
    // latest, and of those starting here the one that ends earliest. Both are
    // found among the cards. Seeded from the neighbouring lines, a card reaching
    // past one of them was measured to that line rather than to its own edge, and
    // the two came out unequal.
    let start = -Infinity;
    let end = Infinity;
    let insStart = 0;
    let insEnd = 0;
    for (const card of this.list) {
      if (card[hi] === line && along[card[lo]] > start) {
        start = along[card[lo]];
        insStart = cardInset(near, axis, card, 'lo', seen);
      }
      if (card[lo] === line && along[card[hi]] < end) {
        end = along[card[hi]];
        insEnd = cardInset(near, axis, card, 'hi', seen);
      }
    }
    // A line no card ends or starts on has no pair to halve. The neighbouring
    // lines are the only edges there are.
    if (start === -Infinity) {
      start = along[line - 1];
      insStart = inset(near, axis, line - 1, 'lo', seen);
    }
    if (end === Infinity) {
      end = along[line + 1];
      insEnd = inset(near, axis, line + 1, 'hi', seen);
    }
    return (start + end) / 2 + (insStart - insEnd) / 2;
  }

  // ---- splitting ---------------------------------------------------------

  /**
   * Returns the position to cut a card at.
   *
   * Prefers the unreferenced line nearest the card's centre that leaves both
   * halves at `minSize`. Otherwise returns a new line at the centre, clamped to
   * the range where both halves fit. `newLine` takes no existing line.
   */
  private cutAt(card: Card, axis: Axis, newLine = false): { line: number; value: number } | null {
    if (card.fixed) return null;

    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    // px per unit of span: the card's own px size, or the sharing slots' ratio.
    const own = fixedSize(card, axis);
    // default: a fixed card takes its px size from `width`/`height`, not from units, so its span can be zero
    // units; its px size then counts per one unit.
    const per = own !== null ? own / (a[card[hi]] - a[card[lo]] || 1) : this.sharedExtent(axis);

    const half = halfCorridor(this.plane, axis);
    const mid = (a[card[lo]] + a[card[hi]]) / 2;
    let lowest = a[card[lo]] + (this.min + cardInset(this.plane, axis, card, 'lo') + half) / per;
    let highest = a[card[hi]] - (this.min + half + cardInset(this.plane, axis, card, 'hi')) / per;
    // Where the halves cannot both have their minimum, the cut is at the centre and the check of the split names the node that it draws
    // below its minimum; a card drawn no wider than the corridor of the cut has no extent for a half.
    if (lowest > highest) {
      if (a[card[lo]] + (cardInset(this.plane, axis, card, 'lo') + half) / per >= mid
        || a[card[hi]] - (half + cardInset(this.plane, axis, card, 'hi')) / per <= mid) return null;
      lowest = mid;
      highest = mid;
    }
    let line = -1;
    for (let i = card[lo] + 1; i < card[hi] && !newLine; i++) {
      if (a[i] < lowest || a[i] > highest) continue;
      if (line < 0 || Math.abs(a[i] - mid) < Math.abs(a[line] - mid)) line = i;
    }
    if (line >= 0) return { line, value: a[line] };
    return { line: -1, value: clamp(mid, lowest, highest) };
  }

  /** The smallest drawn side of every card, by id. Used to compare before and after a change. */
  private extents(axis: Axis): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, r] of this.rects()) out.set(id, axis === 'x' ? r.w : r.h);
    return out;
  }

  /** The cards drawn with no width or no height, by id. */
  private flat(): Set<string> {
    const frame = frameOf(this.plane);
    const out = new Set<string>();
    for (const c of this.list) {
      const r = rectIn(frame, c);
      if (!(r.w > 0) || !(r.h > 0)) out.add(c.id);
    }
    return out;
  }

  /**
   * Whether every card is drawn with a non-zero width and height.
   *
   * `flat` names the cards that already had none before the change. R5 lets a
   * card whose own two lines stand at one place sit inside the one gap that
   * keeps its neighbours apart, so such a card is left where it is: judging it
   * here refused every split, travel and insert anywhere on a plane holding
   * one, however much room the operation had.
   */
  private hasArea(flat: ReadonlySet<string> = new Set()): boolean {
    const frame = frameOf(this.plane);
    return this.list.every((c) => {
      if (flat.has(c.id)) return true;
      const r = rectIn(frame, c);
      return r.w > 0 && r.h > 0;
    });
  }

  /**
   * Whether every card still has the smaller of the size it had and `minSize`.
   *
   * A new line adds a gap, taken from the sharing slots, so a split can reduce a
   * card elsewhere on the plane.
   */
  private stillFits(axis: Axis, before: Map<string, number>, flat?: ReadonlySet<string>): boolean {
    // Every card must have a non-zero area, including one just created.
    if (!this.hasArea(flat)) return false;
    for (const [id, now] of this.extents(axis)) {
      // `minSize` applies only to cards present before the change. A new card
      // has the size it was given, and `cutAt` checks the halves of a cut.
      const was = before.get(id);
      if (was === undefined) continue;
      if (now < Math.min(this.min, was) - 0.01) return false;
    }
    return true;
  }

  /** Whether `split` of the card `id` along `axis` would succeed. */
  canSplit(id: string, axis: Axis): boolean {
    if (this.noAxis(axis)) return false;
    // canSplit performs a trial split, copying the state twice. The result is
    // cached until the next change, because a host redraw calls this once per
    // card per axis: 134 calls at 67 cards.
    const key = `split:${id}:${axis}`;
    const known = this.splitMemo.get(key);
    if (known !== undefined) return known;

    const card = this.find(id);
    let ok = false;
    if (card && this.cutAt(card, axis)) {
      const before = this.toJSON();
      const seq = this.seq;               // a trial must not consume an id
      this.probing = true;
      try {
        this.split(id, axis);
        ok = true;
      } catch {
        // silent: the probe answers whether the split succeeds; the refusal is the answer false.
        ok = false;
      }
      this.restore(before);
      this.probing = false;
      this.seq = seq;
    }
    this.splitMemo.set(key, ok);
    return ok;
  }

  /**
   * Cut one card in two.
   *
   * The original keeps its id and the near half; the new card takes the far
   * half. In the tree the card becomes two kids of its cut when the cut is
   * along the axis, and otherwise a new cut of the two in its place.
   *
   * The new card has no `data` unless `init.data` is given. A px size on the
   * other axis is copied, because both halves stay in that slot. A px size on
   * the cut axis is divided between them.
   *
   * `init.newLine` cuts at a new line at the centre even where a line that the
   * card spans across lies inside it, for a host that places the line itself.
   *
   * Returns the new card's id. Throws its refusal and changes nothing: an
   * unknown axis, an id that the layout holds, an unknown or fixed card, a card
   * drawn no wider than the corridor of the cut, and a cut that draws a node
   * below its minimum, which names the deepest such node.
   */
  split(id: string, axis: Axis, init: { id?: string; data?: unknown; newLine?: boolean } = {}): string {
    if (this.noAxis(axis)) throw new Error(`unknown axis ${String(axis)}; use x or y`);
    return this.run(() => this.splitAt(id, axis, init, false));
  }

  /**
   * Cut a card and put the new one on a named side. The ids are not swapped:
   * toward `left` and `top` the new card takes the near part. Its refusal is
   * the refusal of `split`.
   */
  splitToward(id: string, side: Side, init: { id?: string; data?: unknown; newLine?: boolean } = {}): string {
    // axisOf returns 'y' for any value that is not left or right, so a misspelled
    // side would split downward instead of failing.
    if (!SIDES.includes(side)) throw new Error(`unknown side ${String(side)}; use left, right, top or bottom`);
    return this.run(() => this.splitAt(id, axisOf(side), init, isAhead(side)));
  }

  /**
   * Cuts the card `id` along `axis` at the position of `cutAt`: the card keeps
   * its part of the extent before the cut and the new card takes the part after
   * it, or with `first` the new card takes the part before it.
   */
  private splitAt(
    id: string,
    axis: Axis,
    init: { id?: string; data?: unknown; newLine?: boolean },
    first: boolean,
  ): string {
    // An id already in use would give two nodes the same key. `rects` and the
    // view are both keyed by id, so one card would have no rect and no element.
    if (init.id !== undefined && this.taken(init.id)) throw new Error(`card ${init.id} is a member of the layout`);
    const card = this.find(id);
    if (!card) throw new Error(`card ${id} is not a member of the layout`);
    if (card.fixed) throw new Error(`card ${id} is fixed and does not split`);
    const cut = this.cutAt(card, axis, init.newLine === true);
    if (!cut) {
      // The card is drawn no wider than the corridor of the cut, so a half would have no extent on the axis.
      const r = this.rect(id) as Rect;
      const w = axis === 'x' ? 0 : r.w;
      const h = axis === 'y' ? 0 : r.h - (this.above.get(id) ?? 0);
      const size = `${Math.round(w)}x${Math.round(h)}`;
      // A minSize of zero is no minimum to fall below: the refusal is the area that the half would not have.
      if (this.min === 0) throw new Error(`card ${id} would be ${size} and have no area`);
      const m = String(Math.round(this.min));
      throw new Error(`card ${id} would be ${size}, below its minimum ${m}x${m}`);
    }
    const undo = this.toJSON();
    const leaf = this.leaves.get(id) as CardNode;
    const drawnBefore = this.rects();
    // A cut at the middle gives the halves one fraction each, so they are drawn at one size. A cut at a line of the plane gives
    // each half the fraction of the size that it is drawn at between the edge of the card and that line.
    let f = 0.5;
    if (cut.line >= 0) {
      const [lo, hi] = ENDS[axis];
      const slot = this.spots.get(leaf) as Extent;
      const inset = this.insets.get(leaf) as Extent;
      const extent = this.size(axis);
      const u = this.unit[axis];
      const line = this.arr(axis)[cut.line] * extent;
      const first = line - u / 2 - (slot[lo] * extent + inset[lo]);
      const second = slot[hi] * extent - inset[hi] - line - u / 2;
      if (first > 0 && second > 0) f = first / (first + second);
    }
    // default: `id` is optional; the plane issues one.
    const fresh: CardNode = { card: init.id ?? this.nextId(), fixed: false };
    if (init.data !== undefined) fresh.data = init.data;
    // A px size on the other axis is copied, because both halves stay in that slot.
    const alongside = fixedSize(card, other(axis));
    if (alongside !== null) sizeOn(fresh, other(axis), alongside);
    // A px size on the cut axis is divided in the proportion of the cut.
    const whole = fixedSize(card, axis);
    if (whole !== null) {
      sizeOn(leaf, axis, whole * (first ? 1 - f : f));
      sizeOn(fresh, axis, whole * (first ? f : 1 - f));
      sizeOn(card, axis, whole * (first ? 1 - f : f));
    }
    if (whole === null && cut.line < 0) {
      // A split at the middle is the ADD of the new card beside the card (packages/soksak/docs/layout.md#add-and-remove): along
      // the cut that holds it, an even cut gives the new card 1/(k+1) and an uneven one half of the card; across, two halves.
      const [before, after]: Side[] = axis === 'x' ? ['left', 'right'] : ['top', 'bottom'];
      this.root = insertBeside(this.input(), leaf, first ? before : after, fresh);
    } else {
      const kids = first
        ? [{ share: f, node: fresh }, { share: 1 - f, node: leaf }]
        : [{ share: f, node: leaf }, { share: 1 - f, node: fresh }];
      this.put(leaf, { cut: axis, kids });
    }
    this.derive();
    this.changed();
    this.keepFixed(drawnBefore);
    const below = this.belowMinimum(drawnBefore);
    if (below) {
      this.restore(undo);
      throw new Error(below);
    }
    return fresh.card;
  }

  private nextId(): string {
    let id: string;
    do {
      id = `card-${++this.seq}`;
    } while (this.taken(id));
    return id;
  }

  // ---- closing and moving ------------------------------------------------

  /**
   * Whether a kid is a fixed card, which keeps its size when a sibling leaves. A
   * cut or a box that holds a fixed card is not fixed: its other cards take the
   * share, and its fixed card keeps its size by the rule of its own cut.
   */
  private holdsFixed(node: TreeNode): boolean {
    return isCard(node) && node.fixed === true;
  }

  private removable(id: string): Card | null {
    const card = this.find(id);
    if (!card || card.fixed) return null;
    let free = 0;
    for (const c of this.list) if (!c.fixed && ++free > 1) return card;
    return null;
  }

  /** Whether `close` would remove the card or the box `id`. */
  canClose(id: string): boolean {
    if (this.boxes.has(id)) return this.boxClosing(id);
    return this.closing(id) !== null;
  }

  /**
   * Whether the box `id` can close: a card that is not fixed stands outside it, and its cut holds another kid that is no fixed card,
   * which takes its share.
   */
  private boxClosing(id: string): boolean {
    const box = this.boxes.get(id) as BoxNode;
    const inside = new Set(cardsOf(box).map((leaf) => leaf.card));
    if (!this.list.some((c) => !c.fixed && !inside.has(c.id))) return false;
    const holding = this.up.get(box);
    if (!holding || holding.at < 0) return false;
    const holder = holding.node as CutNode;
    return holder.kids.some((kid, k) => k !== holding.at && !this.holdsFixed(kid.node));
  }

  /**
   * The cut that holds the node leaving with the card `id` and its index in
   * that cut, or null when the card cannot close: it is fixed or the last card,
   * or every other kid of its cut holds a fixed card.
   */
  private closing(id: string): { cut: CutNode; i: number } | null {
    if (!this.removable(id)) return null;
    const holding = this.up.get(this.departing(this.leaves.get(id) as TreeNode));
    if (!holding || holding.at < 0) return null;
    const holder = holding.node as CutNode;
    const i = holding.at;
    if (!holder.kids.some((kid, k) => k !== i && !this.holdsFixed(kid.node))) return null;
    return { cut: holder, i };
  }

  /**
   * Remove a card, or a box with every card inside it (packages/soksak/docs/layout.md#add-and-remove): the node that
   * leaves with it goes out of its cut, and the fractions of the other kids of
   * the cut that are no fixed card scale by one factor, so their ratios hold; a
   * fixed card keeps the size it is drawn at. Returns false, and changes nothing,
   * when the card is `fixed`, when it is the last card or the box holds every card
   * that is not fixed, or when every other kid of its cut is a fixed card.
   */
  close(id: string): boolean {
    return this.run(() => this.closeAlong(id));
  }

  private closeAlong(id: string): boolean {
    if (this.boxes.has(id)) {
      if (!this.boxClosing(id)) return false;
    } else if (!this.closing(id)) return false;
    const leaving = this.boxes.get(id) ?? this.departing(this.leaves.get(id) as TreeNode);
    const drawnBefore = this.rects();
    this.root = withdrawNode(this.input(), isBox(leaving) ? leaving.box : id, this.list).root;
    this.derive();
    this.changed();
    this.keepFixed(drawnBefore);
    return true;
  }

  /**
   * Whether a card spanning the whole plane can be placed on this boundary:
   * the line is an edge of the plane or a seam of the root cut along `axis`.
   * No card crosses such a line, and a line that no card crosses but that two
   * cuts share by chance is no seam, so nothing stands there.
   */
  canInsertAt(axis: Axis, line: number): boolean {
    if (this.noAxis(axis)) return false;
    const a = this.arr(axis);
    if (!Number.isInteger(line) || line < 0 || line > a.length - 1) return false;
    return this.standing(axis, line) !== null;
  }

  /**
   * Where a card spanning the whole plane on the other axis goes in at `line`:
   * the index among the kids of the root, which is a cut along `axis` or becomes
   * one, or null when `line` is no edge of the plane and no seam of the root. A
   * line that no card crosses but that two cuts of the root share by chance is
   * no seam of the root, so nothing goes in there.
   */
  private standing(axis: Axis, line: number): number | null {
    const last = this.arr(axis).length - 1;
    const root = this.root;
    if (!isCut(root) || root.cut !== axis) return line === 0 ? 0 : line === last ? 1 : null;
    const at = root.kids.findIndex((kid) => this.on(kid.node, axis)[0] === line);
    if (at >= 0) return at;
    return line === last ? root.kids.length : null;
  }

  /**
   * Inserts a card at a boundary, spanning the whole plane on the other axis,
   * as a kid of the root cut along `axis`.
   *
   * `size` is required, in px, and must be smaller than the plane. A boundary
   * between kids i and i + 1 of the root is the add of the card beside kid i
   * toward kid i + 1 (packages/soksak/docs/layout.md#boundaries): when the kids
   * that hold no px size on the axis have one drawn size, or kid i holds one,
   * every kid gives a share in proportion and keeps its ratio; otherwise kid i
   * alone gives the span and every other kid keeps its size. An edge of the
   * plane is the add beside the root as a whole, so every kid gives a share in
   * proportion.
   *
   * Returns the new card's id, or null when a card spans the boundary, the line
   * is no seam of the root, the size is invalid, or the result would leave a
   * card with no area or below the size it had and `minSize`.
   */
  insertAt(axis: Axis, line: number, init: { id?: string; data?: unknown; size: number }): string | null {
    if (this.noAxis(axis)) return null;
    if (!init || typeof init !== 'object') return null;
    if (init.id !== undefined && this.taken(init.id)) return null;
    const extent = this.size(axis);
    if (!Number.isFinite(init.size) || init.size < 0 || init.size >= extent) return null;
    if (!this.canInsertAt(axis, line)) return null;
    const at = this.standing(axis, line);
    if (at === null) return null;
    return this.run(() => {
      const was = this.extents(axis);
      const empty = this.flat();
      const undo = this.toJSON();
      // default: `id` is optional; the plane issues one.
      const fresh: CardNode = { card: init.id ?? this.nextId(), fixed: false };
      if (init.data !== undefined) fresh.data = init.data;
      sizeOn(fresh, axis, init.size);
      const [before, after]: Side[] = axis === 'x' ? ['left', 'right'] : ['top', 'bottom'];
      const edge = line === 0 || line === this.arr(axis).length - 1;
      const target = edge ? this.root : (this.root as CutNode).kids[at - 1].node;
      const drawnBefore = this.rects();
      try {
        this.root = insertBeside(this.input(), target, line === 0 ? before : after, fresh);
      } catch {
        this.restore(undo);
        return null;
      }
      this.derive();
      this.changed();
      this.keepFixed(drawnBefore);
      if (!this.stillFits(axis, was, empty)) {
        this.restore(undo);
        return null;
      }
      return fresh.card;
    });
  }

  /**
   * Moves a card that spans the whole plane, a kid of the root cut along `axis`,
   * to another boundary of the root: its kid moves to that place with its share,
   * the kids it passes shift by its span and every other line keeps its
   * coordinate. `fixed` blocks the layout, not a direct call from the host, so a
   * fixed card may be moved.
   *
   * `line` is an index in the current arrangement.
   */
  moveTo(id: string, axis: Axis, line: number): boolean {
    if (this.noAxis(axis)) return false;
    const card = this.find(id);
    const root = this.root;
    if (!card || !isCut(root) || root.cut !== axis) return false;
    const from = root.kids.findIndex((kid) => kid.node === this.leaves.get(id));
    if (from < 0) return false;
    const [lo, hi] = SPAN[axis];
    if (line === card[lo] || line === card[hi]) return true;
    if (!this.canInsertAt(axis, line)) return false;
    let at = this.standing(axis, line);
    if (at === null) return false;
    return this.run(() => {
      const before = this.toJSON();
      const empty = this.flat();
      const [kid] = root.kids.splice(from, 1);
      if ((at as number) > from) at = (at as number) - 1;
      root.kids.splice(at as number, 0, kid);
      this.derive();
      this.changed();
      if (!this.hasArea(empty)) {
        this.restore(before);
        return false;
      }
      return true;
    });
  }

  /**
   * Every boundary a plane-spanning card could stand on: the two edges of the
   * plane and the seams of the root cut along `axis`, in order. A card that
   * stands on one of them blocks none of them.
   */
  standings(axis: Axis): number[] {
    if (this.noAxis(axis)) return [];
    const last = this.arr(axis).length - 1;
    const root = this.root;
    if (!isCut(root) || root.cut !== axis) return [0, last];
    return [...root.kids.map((kid) => this.on(kid.node, axis)[0]), last];
  }

  /**
   * Moves a card to one side of another. This is the drag-and-drop operation.
   *
   * One operation rather than a close and a split sequenced by the caller,
   * because the order matters: the close returns the space first and changes the
   * target's geometry, so the cut is measured after it. A close that cannot
   * happen leaves the arrangement unchanged instead of half changed.
   *
   * The card keeps its id and its payload, so the host's element is reused and a
   * live surface inside it is not destroyed. It keeps its px size only when it
   * lands spanning one slot on that axis.
   */
  move(id: string, targetId: string, side: Side): boolean {
    if (!SIDES.includes(side)) return false;
    return this.run(() => {
      const card = this.find(id);
      const target = this.find(targetId);
      if (!card || !target || card === target || card.fixed) return false;
      // A move is a REMOVE and an ADD (packages/soksak/docs/layout.md#add-and-remove): the card node, with its payload and its
      // px sizes, leaves its cut and is added beside the target.
      const node = cloneNode(this.leaves.get(id) as CardNode);
      const before = this.toJSON();
      if (!this.closeAlong(id)) return false;
      try {
        this.byCuts((input) => insertNode(input, targetId, side, node));
      } catch {
        this.restore(before);
        return false;
      }
      return true;
    });
  }

  /** Whether `move` would succeed, without performing it. */
  canMove(id: string, targetId: string, side: Side): boolean {
    // Performs the move, records the result and restores the state, as canSplit
    // does, and caches it alongside: a host queries four sides on every pointer move.
    const key = `move:${id}:${targetId}:${side}`;
    const known = this.splitMemo.get(key);
    if (known !== undefined) return known;

    const before = this.toJSON();
    const seq = this.seq;
    const probing = this.probing;
    this.probing = true;
    const ok = this.move(id, targetId, side);
    this.restore(before);
    this.probing = probing;
    this.seq = seq;
    this.splitMemo.set(key, ok);
    return ok;
  }

  /**
   * Runs after every operation that changes the arrangement: the sizes agree,
   * and the tree takes the lines and the attributes of the cards.
   *
   * A px size describes one slot, so a card that comes to span two loses it. The
   * value is removed rather than kept for a later split to reapply.
   */
  private changed(): void {
    // A trial split discards its state, so it must not clear the cache.
    if (!this.probing) this.splitMemo.clear();
    this.commit();
  }

  /** Restores the arrangement to a state returned earlier by `toJSON`. */
  private restore(state: SoksakState): void {
    this.load(state);
    if (!this.probing) this.splitMemo.clear();
  }
}
