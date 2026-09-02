/**
 * A soksak over shared grid lines.
 *
 * `xs` and `ys` hold every coordinate as a fraction of the plane. A card is a
 * span of indices into them, so two cards that meet read the same index and
 * their shared boundary is one number. Moving a line moves every card that
 * references it; a card spanning across the line is unaffected.
 *
 * Splitting replaces one card with two, so the arrangement stays a slicing
 * floorplan and every card can be closed.
 *
 * This module holds the state and the operations. `geometry.ts` computes the
 * coordinates.
 */

import { AXES, SPAN, axisOf, fixedSize, isAhead, spanOf } from './card.js';
import type { Axis, Card, CardInit, Rect, Side } from './card.js';
import {
  crossing,
  dividers,
  frameOf,
  inset,
  interiorLines,
  isVirtual,
  linePositions,
  rectIn,
  rectOf,
  rules,
  slotSizes,
  zoneAt,
} from './geometry.js';
import type { Divider, Plane, Rule, ZoneHit, ZoneOptions } from './geometry.js';

export type { Divider, Rule, Zone, ZoneHit, ZoneOptions } from './geometry.js';
import { fillFor, isSlicing } from './slicing.js';
import type { Fill, FillOrder, Span } from './slicing.js';

export type { Axis, Card, CardInit, Rect, Side } from './card.js';
export type { Fill, FillOrder } from './slicing.js';

/** `merge`: a dragged boundary snaps onto a neighbouring line and the two become one. */
export type SnapMode = 'merge' | 'off';

export interface SoksakState {
  xs: number[];
  ys: number[];
  cards: CardInit[];
}

export interface SoksakOptions {
  /** Corridor between two cards, in px. Half of it insets every inner edge. Default 24. */
  gap?: number;
  /** Smallest card edge, in px. Splitting, dragging and resizing all respect it. Default 96. */
  minSize?: number;
  /** Smallest grab area, in px. Kept apart from `gap` so a zero corridor is still grabbable. Default 11. */
  grabSize?: number;
  /** How close a dragged boundary must come to a neighbour to snap onto it, in px. Default 7. */
  snapDistance?: number;
  snap?: SnapMode;
  fillOrder?: FillOrder;
  width?: number;
  height?: number;
}

const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom'];
const EPS = 1e-9;
const clamp = (v: number, lo: number, hi: number): number =>
  lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));

export class Soksak {
  private xs: number[];
  private ys: number[];
  private list: Card[];
  private w: number;
  private h: number;
  private seq = 0;
  private sliceMemo = new Map<string, boolean>();
  private splitMemo = new Map<string, boolean>();
  /**
   * Which side of a card's slot gave up the span it occupies, by card id.
   *
   * `split` and `insertAt` take the span from one neighbour. A close returns it
   * by removing the line on that side, so the two are inverses. Without this
   * the space moves to whichever neighbour the fill picks, and repeating the
   * pair drives one card to `minSize`.
   */
  private paidBy = new Map<string, 'lo' | 'hi'>();
  /** Which side `openSlot` last took its span from. */
  private paid: 'lo' | 'hi' | null = null;
  /** True while canSplit runs a trial split and restores the state. */
  private probing = false;

  private g = 24;

  /** Corridor between two cards, in px. Never negative — a card would overlap. */
  get gap(): number {
    return this.g;
  }

  set gap(px: number) {
    if (!Number.isFinite(px) || px < 0) return;
    this.g = px;
    this.splitMemo.clear();
  }
  minSize: number;
  grabSize: number;
  snapDistance: number;
  snap: SnapMode;
  fillOrder: FillOrder;

  /** Without a state, starts as one card filling the plane. */
  constructor(state?: SoksakState, options: SoksakOptions = {}) {
    this.gap = options.gap ?? 24;
    const min = options.minSize ?? 96;
    this.minSize = Number.isFinite(min) && min >= 0 ? min : 96;
    this.grabSize = options.grabSize ?? 11;
    this.snapDistance = options.snapDistance ?? 7;
    this.snap = options.snap ?? 'merge';
    this.fillOrder = options.fillOrder ?? 'v';
    this.w = options.width ?? 0;
    this.h = options.height ?? 0;

    if (state) {
      this.xs = [...state.xs];
      this.ys = [...state.ys];
      this.list = state.cards.map((c) => ({ ...c, fixed: c.fixed ?? false }));
    } else {
      this.xs = [0, 1];
      this.ys = [0, 1];
      this.list = [{ id: 'card', c0: 0, c1: 1, r0: 0, r1: 1, fixed: false }];
    }
  }

  static from(state: SoksakState, options?: SoksakOptions): Soksak {
    return new Soksak(state, options);
  }

  // ---- the plane ---------------------------------------------------------

  resize(width: number, height: number): void {
    this.w = width;
    this.h = height;
    this.splitMemo.clear();      // plane size changes the answer
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
   * Writes to the returned objects do not reach the grid. Use `setFixed`,
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
   * Replace a card's payload.
   *
   * `data` is opaque to this library.
   */
  setData(id: string, data: unknown): boolean {
    const card = this.find(id);
    if (!card) return false;
    card.data = data;
    return true;
  }

  /**
   * Set whether the layout may split, close or move a card.
   */
  setFixed(id: string, fixed: boolean): boolean {
    const card = this.find(id);
    if (!card) return false;
    card.fixed = fixed;
    return true;
  }

  /**
   * Set a card's px width or height, or `null` for a share of what is left.
   *
   * Applies to a card spanning one slot on that axis. Sets the slot, so every
   * card in it takes the same size. Returns false when the axis or size is
   * invalid or the card spans more than one slot.
   */
  setSize(id: string, axis: Axis, px: number | null): boolean {
    if (axis !== 'x' && axis !== 'y') return false;
    const card = this.find(id);
    if (!card) return false;
    if (px !== null && (!Number.isFinite(px) || px < 0 || spanOf(card, axis) !== 1)) return false;

    // A slot has one size, so set it on every card in the slot.
    const [lo, hi] = SPAN[axis];
    for (const c of this.list) {
      if (c[lo] !== card[lo] || c[hi] !== card[hi]) continue;
      if (axis === 'x') {
        if (px === null) delete c.width;
        else c.width = px;
      } else if (px === null) delete c.height;
      else c.height = px;
    }

    this.changed();
    return true;
  }

  /** The card itself, for the operations that change it. */
  private find(id: string): Card | undefined {
    return this.list.find((c) => c.id === id);
  }

  /** Grid line coordinates, normalised 0..1. A copy — the arrangement owns them. */
  lines(axis: Axis): number[] {
    return [...(axis === 'x' ? this.xs : this.ys)];
  }

  toJSON(): SoksakState {
    return {
      xs: [...this.xs],
      ys: [...this.ys],
      cards: this.list.map((c) => ({ ...c })),
    };
  }

  private get plane(): Plane {
    return { xs: this.xs, ys: this.ys, cards: this.list, width: this.w, height: this.h, gap: this.gap, minSize: this.minSize };
  }

  private arr(axis: Axis): number[] {
    return axis === 'x' ? this.xs : this.ys;
  }

  private size(axis: Axis): number {
    return axis === 'x' ? this.w : this.h;
  }

  // ---- reading the arrangement -------------------------------------------

  rectOf(card: Card): Rect {
    return rectOf(this.plane, card);
  }

  rect(id: string): Rect | undefined {
    const card = this.find(id);
    return card && this.rectOf(card);
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

  /** Cards that span across a line. They are what a card placed on it would cut. */
  cardsCrossing(axis: Axis, line: number): Card[] {
    return crossing(this.plane, axis, line);
  }

  /** How many lines a card spans across — how much finer its neighbours are. */
  crossings(card: Card): number {
    return Math.max(0, card.c1 - card.c0 - 1) + Math.max(0, card.r1 - card.r0 - 1);
  }

  /** True when no card reads this line — it survives only as a snap target. */
  isVirtual(axis: Axis, line: number): boolean {
    return isVirtual(this.plane, axis, line);
  }

  virtualCount(): number {
    let n = 0;
    for (const axis of AXES) for (const k of interiorLines(this.plane, axis)) if (this.isVirtual(axis, k)) n++;
    return n;
  }

  isSlicing(list: readonly Span[] = this.list): boolean {
    return isSlicing(list, this.sliceMemo);
  }

  // ---- boundaries --------------------------------------------------------

  /**
   * Set one slot's drawn size and take the difference from one neighbour.
   *
   * A slot with a px size is not part of what the sharing slots divide, so
   * changing it changed every sharing slot at once. A drag moves one boundary:
   * the two slots meeting there change and no other slot does.
   */
  private resizeSlot(axis: Axis, slot: number, size: number, pays: number): void {
    const a = this.arr(axis);
    const [lo] = SPAN[axis];
    const count = a.length - 1;
    const corridor = (i: number): number =>
      inset(this.plane, axis, i, 'lo') + inset(this.plane, axis, i + 1, 'hi');
    const sizes = slotSizes(this.plane, axis);
    const drawn = sizes.map((s, i) => s - corridor(i));
    const held = new Array<boolean>(count).fill(false);
    for (const c of this.list) if (fixedSize(c, axis) !== null) held[c[lo]] = true;

    const setSize = (i: number, px: number): void => {
      for (const c of this.list) {
        if (c[lo] !== i || fixedSize(c, axis) === null) continue;
        if (axis === 'x') c.width = px;
        else c.height = px;
      }
    };

    const delta = size - drawn[slot];
    setSize(slot, size);
    if (pays < 0 || pays >= count || Math.abs(delta) < EPS) return;

    if (held[pays]) {
      setSize(pays, Math.max(0, drawn[pays] - delta));
      return;
    }

    // The sharing slots divide what the px sizes leave, in proportion to their
    // spans. Re-proportion them to the sizes they should end with, keeping the
    // total span they occupy so every other slot's span stays where it is.
    // The proportion is over slot sizes, corridor included, since that is what
    // the division hands out.
    const want = new Array<number>(count).fill(0);
    let span = 0;
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (held[i]) continue;
      want[i] = Math.max(0, sizes[i] - (i === pays ? delta : 0));
      span += a[i + 1] - a[i];
      total += want[i];
    }
    if (span < EPS || total < EPS) return;

    const end = a[count];
    let at = a[0];
    for (let i = 0; i < count; i++) {
      at += held[i] ? a[i + 1] - a[i] : (span * want[i]) / total;
      a[i + 1] = at;
    }
    a[count] = end;
  }

  /**
   * The card whose px size a drag at this boundary changes, if either slot
   * meeting there has one. Every card in that slot takes the new size.
   */
  private holderAt(axis: Axis, line: number): Card | undefined {
    const [lo, hi] = SPAN[axis];
    const before = this.list.find((c) => c[hi] === line && fixedSize(c, axis) !== null);
    if (before) return before;
    return this.list.find((c) => c[lo] === line && fixedSize(c, axis) !== null);
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
    return linePositions(this.plane, axis)[line];
  }

  /** The nearest line on this side that some card actually reads. */
  private realNeighbour(axis: Axis, line: number, step: -1 | 1): number {
    const last = this.arr(axis).length - 1;
    let at = line + step;
    while (at > 0 && at < last && this.isVirtual(axis, at)) at += step;
    return at;
  }

  /**
   * How far a boundary may travel before a card would fall under `minSize`.
   *
   * The range extends to the nearest line a card references. Lines no card
   * references do not constrain it.
   */
  /**
   * Whether `line` is an interior line index.
   *
   * Index 0 and the last index are the plane's borders and are not boundaries.
   */
  hasBoundary(axis: Axis, line: number): boolean {
    return Number.isInteger(line) && line >= 1 && line <= this.arr(axis).length - 2;
  }

  boundaryRange(axis: Axis, line: number): [number, number] {
    const along = linePositions(this.plane, axis);
    const [lo, hi] = SPAN[axis];

    let min = along[this.realNeighbour(axis, line, -1)] ?? 0;
    let max = along[this.realNeighbour(axis, line, 1)] ?? this.size(axis);
    for (const card of this.list) {
      const near = inset(this.plane, axis, card[lo], 'lo');
      const far = inset(this.plane, axis, card[hi], 'hi');
      if (card[hi] === line) min = Math.max(min, along[card[lo]] + this.minSize + near + far);
      if (card[lo] === line) max = Math.min(max, along[card[hi]] - this.minSize - near - far);
    }
    return [min, max];
  }


  /**
   * Move a boundary to a position in px.
   *
   * Next to a slot with a px size, this changes that size. Otherwise it moves
   * the line and every card referencing it follows.
   *
   * Returns the resulting position.
   */
  moveBoundary(axis: Axis, line: number, px: number, allowSnap = true): number {
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

    // Remove the unreferenced lines the move has passed.
    line = this.forgetLinesPassed(axis, line, target);

    const holder = this.holderAt(axis, line);
    if (holder) {
      // Measure from the edge that is not moving. Both positions are read
      // before the change.
      const [lo, hi] = SPAN[axis];
      const along = linePositions(this.plane, axis);
      const slot =
        holder[hi] === line
          ? target - along[holder[lo]]   // its far edge moved; its start is fixed
          : along[holder[hi]] - target;  // its near edge moved; its end is fixed
      // `slot` is line to line; subtract the corridor to get the drawn size.
      const corridor =
        inset(this.plane, axis, holder[lo], 'lo') + inset(this.plane, axis, holder[hi], 'hi');
      const size = Math.max(0, slot - corridor);
      // The slot on the other side of the boundary pays for the change.
      this.resizeSlot(axis, holder[lo], size, holder[hi] === line ? line : line - 1);
    } else {
      const usable = this.sharedExtent(axis);
      const before = linePositions(this.plane, axis)[line - 1];
      const a = this.arr(axis);
      // Only the shared slots carry normalised width, so convert against those.
      a[line] = usable > EPS ? a[line - 1] + (target - before) / usable : a[line - 1];
    }
    this.changed();
    return this.boundaryPos(axis, line);
  }

  /**
   * Remove the unreferenced lines a move passes, and return the moved index.
   *
   * A line the move has passed would leave the array out of order.
   */
  private forgetLinesPassed(axis: Axis, line: number, target: number): number {
    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    const drop = (k: number): void => {
      a.splice(k, 1);
      for (const card of this.list) {
        if (card[lo] > k) card[lo]--;
        if (card[hi] > k) card[hi]--;
      }
    };
    // `target` is px; the line array is normalised, so compare in px.
    const at = (k: number): number => linePositions(this.plane, axis)[k];
    while (line - 1 >= 1 && this.isVirtual(axis, line - 1) && target < at(line - 1)) {
      drop(line - 1);
      line--;
    }
    while (line + 1 <= a.length - 2 && this.isVirtual(axis, line + 1) && target > at(line + 1)) {
      drop(line + 1);
    }
    if (a !== this.arr(axis)) this.changed();
    return line;
  }

  /** How many px the sharing slots have between them, per unit of normalised span. */
  private sharedExtent(axis: Axis): number {
    const a = this.arr(axis);
    const sizes = slotSizes(this.plane, axis);
    let px = 0;
    let span = 0;
    for (let i = 0; i < sizes.length; i++) {
      const held = this.list.some((c) => c[SPAN[axis][0]] === i && fixedSize(c, axis) !== null);
      if (held) continue;
      px += sizes[i];
      span += a[i + 1] - a[i];
    }
    return span > EPS ? px / span : 0;
  }

  /**
   * Move a boundary so the two cards beside it are the same size.
   *
   * Not the midpoint of the two lines: a card at the plane's border insets on
   * one side only.
   */
  centerBoundary(axis: Axis, line: number): number {
    if (!this.hasBoundary(axis, line)) return this.boundaryPos(axis, line);

    const along = linePositions(this.plane, axis);
    const [lo, hi] = SPAN[axis];
    let start = along[line - 1] ?? 0;
    let end = along[line + 1] ?? this.size(axis);
    let insStart = inset(this.plane, axis, line - 1, 'lo');
    let insEnd = inset(this.plane, axis, line + 1, 'hi');
    for (const card of this.list) {
      if (card[hi] === line && along[card[lo]] >= start) {
        start = along[card[lo]];
        insStart = inset(this.plane, axis, card[lo], 'lo');
      }
      if (card[lo] === line && along[card[hi]] <= end) {
        end = along[card[hi]];
        insEnd = inset(this.plane, axis, card[hi], 'hi');
      }
    }
    return this.moveBoundary(axis, line, (start + end) / 2 + (insStart - insEnd) / 2, false);
  }

  /**
   * Merge a line onto a neighbour at the same coordinate.
   *
   * Returns false when a card spans the pair, which would leave it with no size.
   */
  mergeCoincident(axis: Axis, line: number): boolean {
    if (this.snap === 'off') return false;
    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    const other = [line - 1, line + 1].find(
      (i) => i > 0 && i < a.length - 1 && Math.abs(a[i] - a[line]) < EPS,
    );
    if (other === undefined) return false;
    const at = (card: Card, k: 'c0' | 'c1' | 'r0' | 'r1'): number => (card[k] === line ? other : card[k]);
    if (this.list.some((c) => at(c, lo) === at(c, hi))) return false;
    for (const card of this.list) {
      card[lo] = at(card, lo);
      card[hi] = at(card, hi);
    }
    a.splice(line, 1);
    for (const card of this.list) {
      if (card[lo] > line) card[lo]--;
      if (card[hi] > line) card[hi]--;
    }
    this.changed();
    return true;
  }

  /** Drop lines no card reads any more. Returns how many went. */
  tidy(): number {
    let dropped = 0;
    for (const axis of AXES) {
      const a = this.arr(axis);
      const [lo, hi] = SPAN[axis];
      for (let k = a.length - 2; k >= 1; k--) {
        if (!this.isVirtual(axis, k)) continue;
        a.splice(k, 1);
        for (const card of this.list) {
          if (card[lo] > k) card[lo]--;
          if (card[hi] > k) card[hi]--;
        }
        dropped++;
      }
    }
    if (dropped) this.changed();
    return dropped;
  }

  // ---- splitting ---------------------------------------------------------

  /**
   * Where to cut.
   *
   * The unreferenced line nearest the card's centre that leaves both halves at
   * `minSize`; otherwise a new line at the centre, clamped to the range that
   * fits.
   */
  private cutAt(card: Card, axis: Axis): { line: number; value: number; snapped: boolean } | null {
    if (card.fixed) return null;

    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    // px per unit of span: the card's own size, or what the sharing slots hold.
    const own = fixedSize(card, axis);
    const per = own !== null ? own / (a[card[hi]] - a[card[lo]] || 1) : this.sharedExtent(axis);
    if (per <= EPS) return null;

    const lowest = a[card[lo]] + (this.minSize + inset(this.plane, axis, card[lo], 'lo') + this.gap / 2) / per;
    const highest = a[card[hi]] - (this.minSize + this.gap / 2 + inset(this.plane, axis, card[hi], 'hi')) / per;
    if (lowest > highest) return null;

    const mid = (a[card[lo]] + a[card[hi]]) / 2;
    let line = -1;
    for (let i = card[lo] + 1; i < card[hi]; i++) {
      if (a[i] < lowest || a[i] > highest) continue;
      if (line < 0 || Math.abs(a[i] - mid) < Math.abs(a[line] - mid)) line = i;
    }
    if (line >= 0) return { line, value: a[line], snapped: true };
    return { line: -1, value: clamp(mid, lowest, highest), snapped: false };
  }

  /** The smallest side every card has, so a change can be asked what it cost. */
  private extents(axis: Axis): Map<string, number> {
    const frame = frameOf(this.plane);
    const out = new Map<string, number>();
    for (const card of this.list) {
      const r = rectIn(frame, card);
      out.set(card.id, axis === 'x' ? r.w : r.h);
    }
    return out;
  }

  /**
   * Whether every card still has the room it had, or `minSize`, whichever is
   * less.
   *
   * A new line adds a corridor, which is taken from the shared slots, so a
   * split can push a card elsewhere below its size.
   */
  private stillFits(axis: Axis, before: Map<string, number>): boolean {
    const frame = frameOf(this.plane);
    for (const card of this.list) {
      // Every card must have area, including one just created.
      const r = rectIn(frame, card);
      if (!(r.w > 0 && r.h > 0)) return false;
    }
    for (const [id, now] of this.extents(axis)) {
      // `minSize` applies only to cards that were already present. A new card
      // is the size it was given; the halves of a cut are checked by `cutAt`.
      const was = before.get(id);
      if (was === undefined) continue;
      if (now < Math.min(this.minSize, was) - 0.01) return false;
    }
    return true;
  }

  /** True when the cut would leave every card the room it has, or `minSize`. */
  canSplit(id: string, axis: Axis): boolean {
    // canSplit runs a trial split, which copies the state twice. The result is
    // cached until the next change: a host redraw calls this once per card per
    // axis, 134 times at 67 cards.
    const key = `${id}:${axis}`;
    const known = this.splitMemo.get(key);
    if (known !== undefined) return known;

    const card = this.find(id);
    let ok = false;
    if (card && this.cutAt(card, axis)) {
      const before = this.toJSON();
      const seq = this.seq;               // a trial must not consume an id
      this.probing = true;
      ok = this.split(id, axis) !== null;
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
   * half. Cards spanning the new line widen their span instead of being cut.
   *
   * The new card gets no `data` unless `init.data` is given. A px size on the
   * other axis is copied, since both halves stay in that slot. A px size on the
   * cut axis is divided between them.
   *
   * Returns the new card's id, or null when there is no room.
   */
  split(id: string, axis: Axis, init: { id?: string; data?: unknown } = {}): string | null {
    if (axis !== 'x' && axis !== 'y') return null;
    const card = this.find(id);
    const cut = card && this.cutAt(card, axis);
    if (!card || !cut) return null;
    const was = this.extents(axis);
    const undo = this.toJSON();
    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    // Read before the cut: the new line makes the card span two slots.
    const whole = fixedSize(card, axis);
    const from = a[card[lo]];
    const to = a[card[hi]];

    let line = cut.line;
    if (line < 0) {
      // The new line goes strictly inside the card's span.
      line = card[lo] + 1;
      while (line < card[hi] && a[line] <= cut.value + EPS) line++;
      a.splice(line, 0, cut.value);
      for (const other of this.list) {
        if (other[lo] >= line) other[lo]++;
        if (other[hi] >= line) other[hi]++;
      }
    }

    const fresh: Card = {
      id: init.id ?? this.nextId(),
      c0: card.c0,
      c1: card.c1,
      r0: card.r0,
      r1: card.r1,
      fixed: false,
      data: init.data,
    };
    // A px size on the other axis is copied: both halves stay in that slot.
    const across: Axis = axis === 'x' ? 'y' : 'x';
    const alongside = fixedSize(card, across);
    if (alongside !== null) {
      if (across === 'x') fresh.width = alongside;
      else fresh.height = alongside;
    }
    // A px size on the cut axis is divided in the proportion the line fell at.
    if (whole !== null) {
      const f = to - from > EPS ? (a[line] - from) / (to - from) : 0.5;
      if (axis === 'x') { card.width = whole * f; fresh.width = whole * (1 - f); }
      else { card.height = whole * f; fresh.height = whole * (1 - f); }
    }
    fresh[lo] = line;
    card[hi] = line;
    this.list.push(fresh);
    this.paidBy.set(fresh.id, 'lo');
    this.changed();
    if (!this.stillFits(axis, was)) {
      this.restore(undo);
      return null;
    }
    return fresh.id;
  }

  /**
   * Cut a card and put the new one on a named side.
   *
   * `split` gives the far half to the new card, so `left` and `top` swap the
   * two spans. Ids are not swapped.
   */
  splitToward(id: string, side: Side, init: { id?: string; data?: unknown } = {}): string | null {
    const axis = axisOf(side);
    const card = this.find(id);
    if (!card) return null;
    if (!isAhead(side)) return this.split(id, axis, init);

    const born = this.split(id, axis, init);
    if (born === null) return null;
    const fresh = this.find(born)!;
    const [lo, hi] = SPAN[axis];
    const near: [number, number] = [card[lo], card[hi]];
    card[lo] = fresh[lo];
    card[hi] = fresh[hi];
    fresh[lo] = near[0];
    fresh[hi] = near[1];
    this.paidBy.set(fresh.id, 'hi');   // the halves were swapped
    this.changed();
    return born;
  }

  private nextId(): string {
    let id: string;
    do {
      id = `card-${++this.seq}`;
    } while (this.find(id));
    return id;
  }

  // ---- closing and moving ------------------------------------------------

  fill(id: string): Fill | null {
    const card = this.find(id);
    return card ? fillFor(this.list, card, this.fillOrder, this.sliceMemo) : null;
  }

  /**
   * The axis on which this card's slots hold no other card, or null.
   *
   * On that axis the slots can be removed when the card closes, without a
   * neighbour growing over it. Returns null when another card lies entirely
   * inside the range, which would leave it spanning nothing.
   */
  private soleSlots(card: Card): Axis | null {
    for (const axis of AXES) {
      const [lo, hi] = SPAN[axis];
      // Removing the slots shrinks every card reaching into them. Refused when
      // another card lies entirely inside the range.
      const trapped = this.list.some(
        (other) => other !== card && other[lo] >= card[lo] && other[hi] <= card[hi],
      );
      if (!trapped) return axis;
    }
    return null;
  }

  private removable(id: string): Card | null {
    const card = this.find(id);
    if (!card || card.fixed) return null;
    if (this.list.filter((c) => !c.fixed).length <= 1) return null;
    return card;
  }

  canClose(id: string): boolean {
    const card = this.removable(id);
    return !!card && (!!this.fill(id) || this.soleSlots(card) !== null);
  }

  /**
   * Remove a card.
   *
   * A row of neighbours grows over the space when one matches the side.
   * Otherwise the card's slots are removed. Returns false when neither
   * applies, or when the card is `fixed`, or when it is the last one.
   */
  close(id: string): boolean {
    const card = this.removable(id);
    if (!card) return false;

    // Return the span to the side that gave it up, by removing the line on that
    // side. Only when no other card is in these slots.
    const paid = this.paidBy.get(id);
    if (paid) {
      for (const axis of AXES) {
        const [lo, hi] = SPAN[axis];
        if (card[hi] - card[lo] !== 1) continue;
        const alone = this.list.every(
          (c) => c === card || c[hi] <= card[lo] || c[lo] >= card[hi],
        );
        if (!alone) continue;
        const gone = paid === 'lo' ? card[lo] : card[hi];
        if (gone <= 0 || gone >= this.arr(axis).length - 1) continue;
        // Removing the line grows every card that ends or starts on it. Only
        // the one that gave the span up should grow, so take this path only
        // when it is the sole other card referencing the line.
        const reading = this.list.filter((c) => c !== card && (c[lo] === gone || c[hi] === gone));
        if (reading.length !== 1) continue;
        this.list.splice(this.list.indexOf(card), 1);
        this.removeLine(axis, gone, paid);
        this.paidBy.delete(id);
        this.changed();
        return true;
      }
    }

    const filling = this.fill(id);
    if (filling) {
      for (const neighbour of filling.cards) neighbour[filling.grow] = card[filling.grow];
      this.list.splice(this.list.indexOf(card), 1);
      this.changed();
      return true;
    }

    const axis = this.soleSlots(card);
    if (axis === null) return false;
    const [lo, hi] = SPAN[axis];
    const from = card[lo];
    const count = card[hi] - from;
    this.list.splice(this.list.indexOf(card), 1);
    for (let i = 0; i < count; i++) this.dropSlot(axis, from);
    this.changed();
    return true;
  }

  /**
   * Whether a card reaching across the plane can stand on this boundary.
   *
   * True when no card spans over the line. `without` ignores one card by id.
   */
  canInsertAt(axis: Axis, line: number, without?: string): boolean {
    const a = this.arr(axis);
    if (!Number.isInteger(line) || line < 0 || line > a.length - 1) return false;
    return this.cardsCrossing(axis, line).every((c) => c.id === without);
  }

  /**
   * Put a card at a boundary, reaching across the whole plane.
   *
   * Unlike `splitToward`, the new card spans the whole plane on the other axis.
   * Cards past the boundary shift by one index.
   *
   * `size` is required, in px, and must be less than the plane. It becomes a
   * span taken from the whole plane in proportion.
   *
   * Returns the new card's id, or null when a card spans the boundary, the size
   * is invalid, or the result would leave a card without area.
   */
  insertAt(axis: Axis, line: number, init: { id?: string; data?: unknown; size: number }): string | null {
    const plane = this.size(axis);
    if (!Number.isFinite(init?.size) || init.size < 0 || init.size >= plane) return null;
    if (!this.canInsertAt(axis, line)) return null;
    const was = this.extents(axis);
    const undo = this.toJSON();
    const [lo, hi] = SPAN[axis];
    const across: Axis = axis === 'x' ? 'y' : 'x';
    const [alo, ahi] = SPAN[across];

    this.openSlot(axis, line, init.size / plane);

    const fresh: Card = {
      id: init.id ?? this.nextId(),
      c0: 0, c1: 1, r0: 0, r1: 1,
      fixed: false,
      data: init.data,
    };
    fresh[lo] = line;
    fresh[hi] = line + 1;
    fresh[alo] = 0;
    fresh[ahi] = this.arr(across).length - 1;
    if (axis === 'x') fresh.width = init.size;
    else fresh.height = init.size;
    this.list.push(fresh);
    if (this.paid) this.paidBy.set(fresh.id, this.paid);
    this.changed();
    if (!this.stillFits(axis, was)) {
      this.restore(undo);
      return null;
    }
    return fresh.id;
  }

  /** Whether a card occupies one slot and reaches across everything else. */
  private spansPlane(card: Card, axis: Axis): boolean {
    const [lo, hi] = SPAN[axis];
    const across: Axis = axis === 'x' ? 'y' : 'x';
    const [alo, ahi] = SPAN[across];
    return (
      card[hi] - card[lo] === 1 &&
      card[alo] === 0 &&
      card[ahi] === this.arr(across).length - 1
    );
  }

  /**
   * Insert a slot at a boundary with the given span.
   *
   * Every other slot is scaled by `1 - span`. A card ending at the boundary
   * keeps its index; a card starting there shifts by one.
   */
  private openSlot(axis: Axis, line: number, span: number): void {
    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    // The new slot takes its span from the slot next to the boundary, so a
    // close that merges it back into that slot restores the previous spans.
    // Which slot depends on where there is room.
    const after = line < a.length - 1 ? a[line + 1] - a[line] : 0;
    const before = line > 0 ? a[line] - a[line - 1] : 0;
    this.paid = after >= span ? 'hi' : before >= span ? 'lo' : null;

    if (after >= span) {
      a.splice(line + 1, 0, a[line] + span);
    } else if (before >= span) {
      const at = a[line];
      a[line] = at - span;
      a.splice(line + 1, 0, at);
    } else {
      // Neither neighbour has the room on its own; take it from the whole plane.
      const keep = 1 - span;
      const at = a[line] * keep + span;
      for (let k = 0; k < a.length; k++) a[k] = k <= line ? a[k] * keep : a[k] * keep + span;
      a.splice(line + 1, 0, at);
      a[a.length - 1] = 1;
    }

    for (const card of this.list) {
      if (card[lo] >= line) card[lo]++;
      if (card[hi] > line) card[hi]++;
    }
  }

  /**
   * Remove a slot and scale the rest so they still sum to the plane.
   *
   * Removes the far line, or the near line for the last slot, so the plane's
   * two borders are never removed.
   */
  /**
   * Remove one line and shift the spans that referenced it.
   *
   * `into` says which neighbouring slot absorbs the one that goes, which
   * decides whether a card ending on the line follows it or reaches past it.
   */
  private removeLine(axis: Axis, gone: number, into: 'lo' | 'hi'): void {
    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    a.splice(gone, 1);
    for (const card of this.list) {
      if (card[lo] >= gone) card[lo]--;
      if (into === 'lo' ? card[hi] > gone : card[hi] >= gone) card[hi]--;
    }
  }

  private dropSlot(axis: Axis, slot: number): void {
    const a = this.arr(axis);
    if (a.length <= 2) return; // one slot, no interior line, nothing to take
    const [lo, hi] = SPAN[axis];
    // Remove the interior line: the far one, or the near one for the last slot.
    const last = slot + 1 >= a.length - 1;
    const gone = last ? slot : slot + 1;
    // The neighbouring slot absorbs the span, which is what `openSlot` takes
    // from it, so a slot removed and one opened at the same boundary cancel.
    a.splice(gone, 1);

    for (const card of this.list) {
      if (card[lo] >= gone) card[lo]--;
      if (last ? card[hi] > gone : card[hi] >= gone) card[hi]--;
    }
  }

  /**
   * Move a plane-spanning card to another boundary.
   *
   * Its slot is removed and a slot of the same span is inserted at the target.
   * No other card's spans change and no line on the other axis moves.
   *
   * `line` is an index in the current arrangement.
   */
  moveTo(id: string, axis: Axis, line: number): boolean {
    const card = this.find(id);
    // `fixed` blocks the layout, not a direct call. This changes no other
    // card's spans and no line on the other axis, so it is allowed.
    if (!card || !this.spansPlane(card, axis)) return false;
    const [lo, hi] = SPAN[axis];
    const from = card[lo];
    if (line === from || line === card[hi]) return true;   // already there

    const before = this.toJSON();
    const a = this.arr(axis);
    const was = [...a];
    const span = was[from + 1] - was[from];
    this.list.splice(this.list.indexOf(card), 1);

    // The slot travels; it is not given to a neighbour and taken back from
    // another. Move the indices first, since canInsertAt reads only those.
    a.splice(from + 1, 1);
    for (const c of this.list) {
      if (c[lo] > from) c[lo]--;
      if (c[hi] > from) c[hi]--;
    }

    // The target boundary shifted down by one if it stood past the slot that left.
    const target = line > from + 1 ? line - 1 : line;
    if (!this.canInsertAt(axis, target)) {
      this.restore(before);
      return false;
    }

    a.splice(target, 0, 0);
    for (const c of this.list) {
      if (c[lo] >= target) c[lo]++;
      if (c[hi] > target) c[hi]++;
    }

    // Write every coordinate from the one it had. The cards the slot passes
    // shift by its span once; the rest keep their exact value. Shifting the
    // whole tail out and back added a rounding error to every line.
    if (target <= from) {
      for (let k = 0; k <= target; k++) a[k] = was[k];
      for (let k = target + 1; k <= from + 1; k++) a[k] = was[k - 1] + span;
      for (let k = from + 2; k < a.length; k++) a[k] = was[k];
    } else {
      for (let k = 0; k <= from; k++) a[k] = was[k];
      for (let k = from + 1; k < target; k++) a[k] = was[k + 1] - span;
      a[target] = was[line] - span;
      for (let k = target + 1; k < a.length; k++) a[k] = was[k];
    }
    const across: Axis = axis === 'x' ? 'y' : 'x';
    const [alo, ahi] = SPAN[across];
    card[lo] = target;
    card[hi] = target + 1;
    card[alo] = 0;
    card[ahi] = this.arr(across).length - 1;
    this.list.push(card);
    this.changed();

    // The slot leaves one boundary and arrives at another, so the neighbours
    // that give and take are not the same pair. Refuse when that leaves a card
    // without area.
    const frame = frameOf(this.plane);
    const noArea = this.list.some((c) => {
      const r = rectIn(frame, c);
      return !(r.w > 0 && r.h > 0);
    });
    if (noArea) {
      this.restore(before);
      return false;
    }
    return true;
  }

  /**
   * Every boundary a plane-spanning card could stand on.
   *
   * `without` ignores one card by id, so a card already standing somewhere can
   * ask where else it could stand without blocking itself.
   */
  standings(axis: Axis, without?: string): number[] {
    // Includes the plane's two borders, which `insertAt` accepts.
    const out: number[] = [];
    for (let k = 0; k < this.arr(axis).length; k++) {
      if (this.canInsertAt(axis, k, without)) out.push(k);
    }
    return out;
  }

  /**
   * Move a card to sit on one side of another — the drag-and-drop operation.
   *
   * One operation rather than a close and a split the caller sequences, because
   * the order matters: closing first gives the space back and changes the
   * target's geometry, so the cut is measured after that, and a close that
   * cannot happen leaves the whole move undone rather than half of it.
   *
   * The card keeps its id, its payload and its fixed size, so a live surface
   * rides along and a sidebar stays the width it was.
   */
  move(id: string, targetId: string, side: Side): boolean {
    if (!SIDES.includes(side)) return false;
    const card = this.find(id);
    const target = this.find(targetId);
    if (!card || !target || card === target || card.fixed) return false;

    const carried = { data: card.data, width: card.width, height: card.height };
    const before = this.toJSON();
    if (!this.close(id)) return false;
    const landed = this.splitToward(targetId, side, { id, data: carried.data });
    if (landed === null) {
      this.restore(before);
      return false;
    }
    const moved = this.find(landed)!;
    // The size a card holds is its own; the axis it now stands on decides which.
    if (axisOf(side) === 'x') {
      if (carried.width !== undefined) moved.width = carried.width;
      if (carried.height !== undefined && spanOf(moved, 'y') === 1) moved.height = carried.height;
    } else {
      if (carried.height !== undefined) moved.height = carried.height;
      if (carried.width !== undefined && spanOf(moved, 'x') === 1) moved.width = carried.width;
    }
    this.changed();
    return true;
  }

  /** Whether `move` would succeed, without performing it. */
  canMove(id: string, targetId: string, side: Side): boolean {
    const probe = new Soksak(this.toJSON(), {
      gap: this.gap,
      minSize: this.minSize,
      grabSize: this.grabSize,
      snapDistance: this.snapDistance,
      snap: this.snap,
      fillOrder: this.fillOrder,
      width: this.w,
      height: this.h,
    });
    return probe.move(id, targetId, side);
  }

  /** Put the arrangement back to a state it reported earlier. */
  /**
   * What every operation does when it is finished.
   *
   * A px size describes one slot. A card that comes to reach across two is not
   * that size any more and cannot be — so the number goes, rather than lying
   * dormant on the card and coming back to life at some later, unrelated split.
   */
  private changed(): void {
    // A trial split discards its state, so it must not clear the cache.
    if (!this.probing) this.splitMemo.clear();
    for (const card of this.list) {
      if (card.width !== undefined && card.c1 - card.c0 !== 1) delete card.width;
      if (card.height !== undefined && card.r1 - card.r0 !== 1) delete card.height;
    }
    // Two cards in one slot: use the larger size for both.
    for (const axis of AXES) {
      const [lo] = SPAN[axis];
      const agreed = new Map<number, number>();
      for (const card of this.list) {
        const size = fixedSize(card, axis);
        if (size === null) continue;
        agreed.set(card[lo], Math.max(agreed.get(card[lo]) ?? 0, size));
      }
      for (const card of this.list) {
        if (fixedSize(card, axis) === null) continue;
        const size = agreed.get(card[lo]) as number;
        if (axis === 'x') card.width = size;
        else card.height = size;
      }
    }
    this.sliceMemo.clear();
  }

  private restore(state: SoksakState): void {
    this.xs = [...state.xs];
    this.ys = [...state.ys];
    this.list = state.cards.map((c) => ({ ...c, fixed: c.fixed ?? false }));
    this.sliceMemo.clear();
    if (!this.probing) this.splitMemo.clear();
  }
}
