/**
 * A soksak over shared grid lines.
 *
 * `xs` and `ys` hold every coordinate, normalised 0..1 over the slots that
 * share what is left. A slot held at a px size is drawn at that size whatever
 * its span, so a line's position in px is not its number times the plane. A
 * card is a span of indices into them, so two cards that meet read the same
 * index and their shared boundary is one number. Moving a line moves every card that
 * references it; a card spanning across the line is unaffected.
 *
 * Splitting replaces one card with two, so the arrangement stays a slicing
 * floorplan and every card can be closed.
 *
 * This module holds the state and the operations. `geometry.ts` computes the
 * coordinates.
 */

import { AXES, SIDES, SPAN, axisOf, fixedSize, isAhead, other, spanOf } from './card.js';
import type { Axis, Card, CardInit, Rect, Side } from './card.js';
import {
  corridorOf,
  crossing,
  dividers,
  frameOf,
  linesReadOn,
  halfCorridor,
  heldSizes,
  inset,
  interiorLines,
  isVirtual,
  linePositions,
  rectIn,
  rectOf,
  rules,
  slotSizes,
  slotWidths,
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

/** Where a card's slot came from: which side of it, and the card that gave it. */
export interface Paid {
  side: 'lo' | 'hi';
  to: string;
}

export interface SoksakState {
  xs: number[];
  ys: number[];
  cards: CardInit[];
  /**
   * Which side each card took its slot from, by id.
   *
   * A close hands the slot back to the neighbour that gave it up, so this
   * decides where the room goes. It is part of the state: without it a grid
   * built from `toJSON` draws the same rects but closes cards differently.
   */
  paidBy?: Record<string, Paid>;
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

const EPS = 1e-9;

/**
 * Slots to try when settling a change, nearest the boundary first: `from`,
 * then `back`, then outward from each.
 */
const order = (from: number, count: number, back = from - 1): number[] => {
  const out: number[] = [];
  for (let step = 0; step < count; step++) {
    out.push(from + step, back - step);
  }
  return out.filter((i) => i >= 0 && i < count);
};
/**
 * Refuse a state that cannot describe a plane, naming what is wrong.
 *
 * A stale layout read back from storage otherwise reaches the geometry, where
 * an index outside the line array or a coordinate that is not a number turns
 * into a NaN rect. In the DOM that becomes `left: NaNpx`, which the CSSOM
 * drops, so the view freezes at its last good layout with nothing to report.
 */
export function checkState(state: SoksakState): void {
  const bad = (why: string): never => {
    throw new TypeError(`soksak: ${why}`);
  };
  for (const axis of ['xs', 'ys'] as const) {
    const a = state?.[axis];
    if (!Array.isArray(a) || a.length < 2) bad(`${axis} needs at least two lines`);
    for (const [i, v] of a.entries()) {
      if (!Number.isFinite(v)) bad(`${axis}[${i}] is ${String(v)}`);
      if (i > 0 && v < a[i - 1]) bad(`${axis}[${i}] is before ${axis}[${i - 1}]`);
    }
  }
  if (!Array.isArray(state.cards) || state.cards.length === 0) bad('cards is empty');
  const seen = new Set<string>();
  for (const c of state.cards) {
    if (typeof c?.id !== 'string' || !c.id) bad('a card has no id');
    if (seen.has(c.id)) bad(`two cards are called ${c.id}`);
    seen.add(c.id);
    for (const [lo, hi, axis] of [
      ['c0', 'c1', 'xs'],
      ['r0', 'r1', 'ys'],
    ] as const) {
      const a = state[axis];
      const from = c[lo];
      const to = c[hi];
      if (!Number.isInteger(from) || !Number.isInteger(to)) bad(`${c.id}.${lo}/${hi} is not an index`);
      if (from < 0 || to > a.length - 1) bad(`${c.id}.${lo}/${hi} is outside ${axis}`);
      if (to <= from) bad(`${c.id}.${hi} is not past ${c.id}.${lo}`);
    }
  }
}

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
  private paidBy = new Map<string, Paid>();
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
  private min: number;

  /** The smallest a card may be drawn on either axis. */
  get minSize(): number {
    return this.min;
  }

  /** Writing it clears the cached answers that were computed against the old one. */
  set minSize(px: number) {
    if (!Number.isFinite(px) || px < 0) return;
    this.min = px;
    this.splitMemo.clear();
  }

  private order: FillOrder;

  /** Which axis a close tries first. */
  get fillOrder(): FillOrder {
    return this.order;
  }

  set fillOrder(value: FillOrder) {
    if (value !== 'v' && value !== 'h') return;
    this.order = value;
    this.sliceMemo.clear();
    this.splitMemo.clear();
  }

  grabSize: number;
  snapDistance: number;
  snap: SnapMode;

  /** Without a state, starts as one card filling the plane. */
  constructor(state?: SoksakState, options: SoksakOptions = {}) {
    this.gap = options.gap ?? 24;
    const min = options.minSize ?? 96;
    this.min = Number.isFinite(min) && min >= 0 ? min : 96;
    this.grabSize = options.grabSize ?? 11;
    this.snapDistance = options.snapDistance ?? 7;
    this.snap = options.snap ?? 'merge';
    this.order = options.fillOrder ?? 'v';
    this.w = options.width ?? 0;
    this.h = options.height ?? 0;

    if (state) {
      checkState(state);
      this.xs = [...state.xs];
      this.ys = [...state.ys];
      this.list = state.cards.map((c) => ({ ...c, fixed: c.fixed ?? false }));
      this.paidBy = new Map(Object.entries(state.paidBy ?? {}));
    } else {
      this.xs = [0, 1];
      this.ys = [0, 1];
      this.list = [{ id: 'card', c0: 0, c1: 1, r0: 0, r1: 1, fixed: false }];
    }
    this.agreeSizes();
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
    // A fixed card does not grow over a departing neighbour, so this changes
    // what a split and a close can do.
    this.splitMemo.clear();
    this.sliceMemo.clear();
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
    if (this.noAxis(axis)) return false;
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
    if (this.noAxis(axis)) return [];
    return [...(axis === 'x' ? this.xs : this.ys)];
  }

  toJSON(): SoksakState {
    return {
      xs: [...this.xs],
      ys: [...this.ys],
      cards: this.list.map((c) => ({ ...c })),
      paidBy: Object.fromEntries(this.paidBy),
    };
  }

  private get plane(): Plane {
    return { xs: this.xs, ys: this.ys, cards: this.list, width: this.w, height: this.h, gap: this.gap, minSize: this.min };
  }

  private arr(axis: Axis): number[] {
    return axis === 'x' ? this.xs : this.ys;
  }

  /** An axis the caller made up. Every public method that takes one refuses. */
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

  /** Cards that span across a line, as frozen copies. They are what a card placed on it would cut. */
  cardsCrossing(axis: Axis, line: number): readonly Card[] {
    if (this.noAxis(axis)) return [];
    return crossing(this.plane, axis, line).map((c) => Object.freeze({ ...c }));
  }

  /** How many lines a card spans across — how much finer its neighbours are. */
  crossings(card: Card): number {
    return Math.max(0, card.c1 - card.c0 - 1) + Math.max(0, card.r1 - card.r0 - 1);
  }

  /** True when no card reads this line — it survives only as a snap target. */
  isVirtual(axis: Axis, line: number): boolean {
    if (this.noAxis(axis)) return false;
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

  /** Set the px size every card in a slot declares. */
  private declare(axis: Axis, slot: number, size: number): void {
    const [lo] = SPAN[axis];
    for (const c of this.list) {
      if (c[lo] !== slot || fixedSize(c, axis) === null) continue;
      if (axis === 'x') c.width = size;
      else c.height = size;
    }
  }

  /** Whether every card has its minimum, as the plane stands. */
  private fits(axis: Axis): boolean {
    for (const w of this.extents(axis).values()) if (w < this.min - EPS) return false;
    return true;
  }

  /**
   * Give each sharing slot the width `want` names for it. A slot named `null`
   * takes what is left over, shared with the other `null` slots in proportion
   * to the span it holds.
   *
   * A px size is declared by the host, so this never changes one: a held slot
   * keeps its size whatever `want` says. Naming the widths settles a change
   * with the slots it touches and leaves the rest where they are.
   */
  private setSlotWidths(axis: Axis, want: readonly (number | null)[]): void {
    const a = this.arr(axis);
    const count = a.length - 1;
    if (want.length !== count || this.size(axis) <= 0) return;
    const plane = this.plane;
    const read = linesReadOn(plane, axis);
    const held = heldSizes(plane, axis);
    const sizes = slotSizes(plane, axis);

    // What the sharing slots divide between them, measured as the plane stands.
    // It does not depend on how they currently divide it.
    let room = 0;
    let span = 0;
    for (let i = 0; i < count; i++) {
      if (held[i] !== null) continue;
      room += sizes[i];
      span += a[i + 1] - a[i];
    }
    if (span < EPS || room < EPS) return;

    const size = new Array<number>(count).fill(0);
    let named = 0;
    let open = 0;
    let nulls = 0;
    for (let i = 0; i < count; i++) {
      if (held[i] !== null) continue;
      if (want[i] === null) {
        open += a[i + 1] - a[i];
        nulls++;
      } else {
        size[i] = Math.max(0, (want[i] as number) + corridorOf(plane, axis, i, read));
        named += size[i];
      }
    }
    const left = Math.max(0, room - named);
    for (let i = 0; i < count; i++) {
      if (held[i] !== null || want[i] !== null) continue;
      size[i] = open > EPS ? (left * (a[i + 1] - a[i])) / open : left / nulls;
    }

    // Re-proportion the sharing spans to those sizes, keeping the total span
    // they occupy so no other line moves. Read the spans from a copy: the loop
    // writes into `a` as it goes.
    const total = named + left;
    if (total < EPS) return;
    const was = [...a];
    let at = a[0];
    for (let i = 0; i < count; i++) {
      at += held[i] !== null ? was[i + 1] - was[i] : (span * size[i]) / total;
      a[i + 1] = at;
    }
    a[count] = was[count];
  }

  /**
   * Settle a change with the sharing slot nearest the boundary.
   *
   * `order` lists the slots to try, nearest first. The first one that leaves
   * every card its minimum takes the room; when none does, every sharing slot
   * shares it. Each candidate is applied and then measured, so the slot sizes
   * come from `slotSizes` alone and no second calculation can disagree with it.
   *
   * Returns the slot that took the room, or -1.
   */
  private settleOn(axis: Axis, want: (number | null)[], order: readonly number[]): number {
    const held = heldSizes(this.plane, axis);
    const undo = this.toJSON();
    for (const slot of order) {
      if (slot < 0 || slot >= want.length || held[slot] !== null) continue;
      const had = want[slot];
      want[slot] = null;
      this.setSlotWidths(axis, want);
      if (this.fits(axis)) return slot;
      this.restore(undo);
      want[slot] = had;
    }
    for (let i = 0; i < want.length; i++) if (held[i] === null) want[i] = null;
    this.setSlotWidths(axis, want);
    return -1;
  }

  /**
   * Set one slot's px size and take the difference from the slot on the other
   * side of the boundary.
   *
   * A drag moves one boundary: the two slots meeting there change and no other
   * slot does. `slot` and `pays` are the two slots a boundary separates, so
   * they are always in range and never the same one.
   */
  private resizeSlot(axis: Axis, slot: number, size: number, pays: number): void {
    const width = slotWidths(this.plane, axis);
    const delta = size - width[slot];
    this.declare(axis, slot, size);

    const want: (number | null)[] = [...width];
    want[slot] = size;
    if (heldSizes(this.plane, axis)[pays] !== null) {
      // Two px slots meet here: the one after gives up what the one before took.
      this.declare(axis, pays, Math.max(0, width[pays] - delta));
      this.setSlotWidths(axis, want);
      return;
    }
    want[pays] = null;
    this.setSlotWidths(axis, want);
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
    if (this.noAxis(axis) || !Number.isInteger(line)) return 0;
    const along = linePositions(this.plane, axis);
    return line >= 0 && line < along.length ? along[line] : 0;
  }

  /** The nearest line on this side that some card actually reads. */
  private realNeighbour(axis: Axis, line: number, step: -1 | 1): number {
    const last = this.arr(axis).length - 1;
    let at = line + step;
    while (at > 0 && at < last && this.isVirtual(axis, at)) at += step;
    return at;
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
   * How far a boundary may travel before a card would fall under `minSize`.
   *
   * The range reaches to the nearest line a card references; lines no card
   * references do not constrain it. When two cards ask for more room than the
   * plane holds it is one point, never an inverted pair.
   */
  boundaryRange(axis: Axis, line: number): [number, number] {
    if (this.noAxis(axis)) return [0, 0];
    const along = linePositions(this.plane, axis);
    const [lo, hi] = SPAN[axis];

    // The neighbouring lines are the hard limits: past one of them the line
    // array is out of order, and a card gets drawn wider than one that spans
    // more slots than it does.
    const first = along[this.realNeighbour(axis, line, -1)] ?? 0;
    const last = along[this.realNeighbour(axis, line, 1)] ?? this.size(axis);
    let min = first;
    let max = last;
    const plane = this.plane;
    const read = linesReadOn(plane, axis);   // one pass, not two per card
    for (const card of this.list) {
      const near = inset(plane, axis, card[lo], 'lo', read);
      const far = inset(plane, axis, card[hi], 'hi', read);
      if (card[hi] === line) min = Math.max(min, along[card[lo]] + this.min + near + far);
      if (card[lo] === line) max = Math.min(max, along[card[hi]] - this.min - near - far);
    }
    // Two cards can ask for more room than the plane holds. Neither gets its
    // minimum then, so the range is one point between the neighbours rather
    // than an inverted pair every caller has to guard against.
    if (min > max) {
      const mid = clamp((min + max) / 2, first, last);
      return [mid, mid];
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
    if (this.noAxis(axis)) return 0;
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
      // A card holding a px size stands in one slot: `changed` drops the size
      // from a card that spans more.
      const size = Math.max(0, slot - corridorOf(this.plane, axis, holder[lo]));
      // The slot on the other side of the boundary pays for the change.
      this.resizeSlot(axis, holder[lo], size, holder[hi] === line ? line : line - 1);
    } else {
      const usable = this.sharedExtent(axis);
      const before = linePositions(this.plane, axis)[line - 1];
      const a = this.arr(axis);
      // Only the shared slots carry normalised width, so convert against those.
      const want = usable > EPS ? a[line - 1] + (target - before) / usable : a[line - 1];
      // The conversion divides by one average slope, and the slots do not all
      // sit on it once a px size is in play, so it can answer past a
      // neighbouring line. A line past its neighbour puts the array out of
      // order and draws a card wider than one spanning more slots.
      a[line] = clamp(want, a[line - 1], a[line + 1]);
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
    // No card reads these lines, so which neighbour absorbs makes no difference.
    const drop = (k: number): void => this.removeLine(axis, k, 'lo');
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
    const held = heldSizes(this.plane, axis);
    let px = 0;
    let span = 0;
    for (let i = 0; i < sizes.length; i++) {
      if (held[i] !== null) continue;
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
    if (this.noAxis(axis)) return 0;
    if (!this.hasBoundary(axis, line)) return this.boundaryPos(axis, line);

    const along = linePositions(this.plane, axis);
    const [lo, hi] = SPAN[axis];
    let start = along[line - 1] ?? 0;
    let end = along[line + 1] ?? this.size(axis);
    const near = this.plane;
    const seen = linesReadOn(near, axis);
    let insStart = inset(near, axis, line - 1, 'lo', seen);
    let insEnd = inset(near, axis, line + 1, 'hi', seen);
    for (const card of this.list) {
      if (card[hi] === line && along[card[lo]] >= start) {
        start = along[card[lo]];
        insStart = inset(near, axis, card[lo], 'lo', seen);
      }
      if (card[lo] === line && along[card[hi]] <= end) {
        end = along[card[hi]];
        insEnd = inset(near, axis, card[hi], 'hi', seen);
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
    if (this.noAxis(axis)) return false;
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
    // Every card now reads `other`, so which neighbour absorbs makes no
    // difference.
    this.removeLine(axis, line, 'lo');
    this.changed();
    return true;
  }

  /** Drop lines no card reads any more. Returns how many went. */
  tidy(): number {
    let dropped = 0;
    for (const axis of AXES) {
      for (let k = this.arr(axis).length - 2; k >= 1; k--) {
        if (!this.isVirtual(axis, k)) continue;
        // No card reads the line, so which neighbour absorbs makes no difference.
        this.removeLine(axis, k, 'lo');
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
  private cutAt(card: Card, axis: Axis): { line: number; value: number } | null {
    if (card.fixed) return null;

    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    // px per unit of span: the card's own size, or what the sharing slots hold.
    const own = fixedSize(card, axis);
    const per = own !== null ? own / (a[card[hi]] - a[card[lo]] || 1) : this.sharedExtent(axis);
    if (per <= EPS) return null;

    const half = halfCorridor(this.plane, axis);
    const lowest = a[card[lo]] + (this.min + inset(this.plane, axis, card[lo], 'lo') + half) / per;
    const highest = a[card[hi]] - (this.min + half + inset(this.plane, axis, card[hi], 'hi')) / per;
    if (lowest > highest) return null;

    const mid = (a[card[lo]] + a[card[hi]]) / 2;
    let line = -1;
    for (let i = card[lo] + 1; i < card[hi]; i++) {
      if (a[i] < lowest || a[i] > highest) continue;
      if (line < 0 || Math.abs(a[i] - mid) < Math.abs(a[line] - mid)) line = i;
    }
    if (line >= 0) return { line, value: a[line] };
    return { line: -1, value: clamp(mid, lowest, highest) };
  }

  /** The smallest side every card has, so a change can be asked what it cost. */
  private extents(axis: Axis): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, r] of this.rects()) out.set(id, axis === 'x' ? r.w : r.h);
    return out;
  }

  /** Whether every card is drawn with area. A card with none is not a card. */
  private hasArea(): boolean {
    const frame = frameOf(this.plane);
    return this.list.every((c) => {
      const r = rectIn(frame, c);
      return r.w > 0 && r.h > 0;
    });
  }

  /**
   * Whether every card still has the room it had, or `minSize`, whichever is
   * less.
   *
   * A new line adds a corridor, which is taken from the shared slots, so a
   * split can push a card elsewhere below its size.
   */
  private stillFits(axis: Axis, before: Map<string, number>): boolean {
    // Every card must have area, including one just created.
    if (!this.hasArea()) return false;
    for (const [id, now] of this.extents(axis)) {
      // `minSize` applies only to cards that were already present. A new card
      // is the size it was given; the halves of a cut are checked by `cutAt`.
      const was = before.get(id);
      if (was === undefined) continue;
      if (now < Math.min(this.min, was) - 0.01) return false;
    }
    return true;
  }

  /** True when the cut would leave every card the room it has, or `minSize`. */
  canSplit(id: string, axis: Axis): boolean {
    if (this.noAxis(axis)) return false;
    // canSplit runs a trial split, which copies the state twice. The result is
    // cached until the next change: a host redraw calls this once per card per
    // axis, 134 times at 67 cards.
    const key = `split:${id}:${axis}`;
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
    if (this.noAxis(axis)) return null;
    // An id already in use would give two cards one name: `rects` and the view
    // key by id, so one of them would have no rect and no element.
    if (init.id !== undefined && this.find(init.id)) return null;
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
      // A line inside a card, not a slot at a boundary: every span at or past
      // this index moves with it, including a card that ends here.
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
    const across = other(axis);
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
    this.paidBy.set(fresh.id, { side: 'lo', to: card.id });
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
    // axisOf answers 'y' for anything that is not left or right, so a
    // misspelled side would split downward without saying so.
    if (!SIDES.includes(side)) return null;
    if (init.id !== undefined && this.find(init.id)) return null;
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
    this.paidBy.set(fresh.id, { side: 'hi', to: card.id });   // the halves were swapped
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

  /**
   * Which neighbours would grow over a card if it closed, as frozen copies.
   *
   * `null` when no row of neighbours matches a side, which is when `close`
   * removes the card's slots instead.
   */
  fill(id: string): Fill | null {
    const found = this.fillOf(id);
    return found && { ...found, cards: found.cards.map((c) => Object.freeze({ ...c })) };
  }

  /** The same, holding the cards themselves, so `close` can grow them. */
  private fillOf(id: string): Fill | null {
    const card = this.find(id);
    return card ? fillFor(this.list, card, this.order, this.sliceMemo) : null;
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
    return !!card && (!!this.fillOf(id) || this.soleSlots(card) !== null);
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
        const gone = paid.side === 'lo' ? card[lo] : card[hi];
        if (gone <= 0 || gone >= this.arr(axis).length - 1) continue;
        // Removing the line grows every card that ends or starts on it. Only
        // the one that gave the span up should grow, so take this path only
        // when it is the sole other card referencing the line.
        const reading = this.list.filter((c) => c !== card && (c[lo] === gone || c[hi] === gone));
        if (reading.length !== 1) continue;
        const held = slotWidths(this.plane, axis);
        const mine = card[lo];
        this.list.splice(this.list.indexOf(card), 1);
        this.removeLine(axis, gone, paid.side);
        this.paidBy.delete(id);
        // The card's slot goes; the neighbour it merges into keeps the width it
        // had, and the slot that gave the room up takes it back. No other slot
        // changes width.
        const back = this.find(paid.to);
        const want: (number | null)[] = held.filter((_, i) => i !== mine);
        const merged = paid.side === 'lo' ? mine - 1 : mine;
        this.settleOn(axis, want, order(back ? back[lo] : merged, want.length));
        this.changed();
        return true;
      }
    }

    const filling = this.fillOf(id);
    if (filling) {
      const axis: Axis = filling.grow === 'c0' || filling.grow === 'c1' ? 'x' : 'y';
      const [lo, hi] = SPAN[axis];
      const from = card[lo];
      const to = card[hi];
      const want: (number | null)[] = slotWidths(this.plane, axis);
      for (const neighbour of filling.cards) neighbour[filling.grow] = card[filling.grow];
      this.list.splice(this.list.indexOf(card), 1);
      // The slots the card stood in go to the neighbour that grew over them.
      // Every other slot keeps the width it had.
      this.settleOn(axis, want, order(from, want.length, to - 1));
      this.changed();
      return true;
    }

    const axis = this.soleSlots(card);
    if (axis === null) return false;
    const [lo, hi] = SPAN[axis];
    const from = card[lo];
    const count = card[hi] - from;
    const held = slotWidths(this.plane, axis);
    this.list.splice(this.list.indexOf(card), 1);
    for (let i = 0; i < count; i++) this.dropSlot(axis, from);
    // The slots are gone; the neighbour that absorbed them takes the room.
    const kept: (number | null)[] = held.filter((_, i) => i < from || i >= from + count);
    this.settleOn(axis, kept, order(Math.min(from, kept.length - 1), kept.length));
    this.changed();
    return true;
  }

  /**
   * Whether a card reaching across the plane can stand on this boundary.
   *
   * True when no card spans over the line. `without` ignores one card by id.
   */
  canInsertAt(axis: Axis, line: number, without?: string): boolean {
    if (this.noAxis(axis)) return false;
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
    if (this.noAxis(axis)) return null;
    if (init?.id !== undefined && this.find(init.id)) return null;
    const plane = this.size(axis);
    // A size that takes the whole plane leaves the cards already there none,
    // and `openSlot` writes the new line before the plane's start to make the
    // room. Refused here, where the size is read, rather than found afterwards
    // by measuring what it did.
    if (!Number.isFinite(init?.size) || init.size < 0 || init.size >= plane) return null;
    if (!this.canInsertAt(axis, line)) return null;
    const was = this.extents(axis);
    const undo = this.toJSON();
    const [lo, hi] = SPAN[axis];
    const across = other(axis);
    const [alo, ahi] = SPAN[across];

    const held = slotWidths(this.plane, axis);
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

    // The slot next to the new one pays for it, so a close at the same
    // boundary hands the room straight back. Every other slot keeps its width.
    const want: (number | null)[] = new Array<number | null>(this.arr(axis).length - 1).fill(0);
    for (let i = 0; i < held.length; i++) want[i >= line ? i + 1 : i] = held[i];
    want[line] = init.size;
    const pays = this.settleOn(axis, want, order(line + 1, want.length, line - 1));
    // Name the slot that paid, not just the side it is on: the nearest slot may
    // have been unable to give the room, and a close hands it back by name.
    const payer = pays >= 0 ? this.list.find((c) => c[lo] === pays && c !== fresh) : undefined;
    if (payer) this.paidBy.set(fresh.id, { side: pays > line ? 'hi' : 'lo', to: payer.id });
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
    const across = other(axis);
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
    // The new slot takes its span from the slot next to the boundary, so a
    // close that merges it back into that slot restores the previous spans.
    // Which slot depends on where there is room.
    const after = line < a.length - 1 ? a[line + 1] - a[line] : 0;
    const before = line > 0 ? a[line] - a[line - 1] : 0;

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

    this.openIndex(axis, line);
  }

  /**
   * Open a slot at a boundary and shift the spans that referenced it.
   *
   * A card that starts on the line moves past the new slot; one that ends on it
   * stays where it ends. This is what `removeLine(axis, line, 'hi')` undoes.
   */
  private openIndex(axis: Axis, line: number): void {
    const [lo, hi] = SPAN[axis];
    for (const card of this.list) {
      if (card[lo] >= line) card[lo]++;
      if (card[hi] > line) card[hi]++;
    }
  }

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

  /**
   * Remove one slot by removing a line beside it.
   *
   * The far line, or the near one for the last slot, so the plane's two borders
   * are never removed.
   */
  private dropSlot(axis: Axis, slot: number): void {
    const a = this.arr(axis);
    if (a.length <= 2) return; // one slot, no interior line, nothing to take
    // Remove the interior line: the far one, or the near one for the last slot,
    // so the plane's two borders are never removed. The neighbour that absorbs
    // the slot is the one on the other side of the line that goes.
    const last = slot + 1 >= a.length - 1;
    this.removeLine(axis, last ? slot : slot + 1, last ? 'lo' : 'hi');
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
    if (this.noAxis(axis)) return false;
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
    // The card is out of the list, so the slot after it absorbs the line.
    this.removeLine(axis, from + 1, 'hi');

    // The target boundary shifted down by one if it stood past the slot that left.
    const target = line > from + 1 ? line - 1 : line;
    if (!this.canInsertAt(axis, target)) {
      this.restore(before);
      return false;
    }

    a.splice(target, 0, 0);
    this.openIndex(axis, target);

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
    const across = other(axis);
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
    if (!this.hasArea()) {
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
    if (this.noAxis(axis)) return [];
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
   * The card keeps its id and its payload, so the host's element is reused and
   * a live surface inside it is not torn down. It keeps its px size only when it
   * lands spanning one slot on that axis.
   */
  move(id: string, targetId: string, side: Side): boolean {
    // A side that is not one is refused by `splitToward` below, and the close
    // before it is put back, so this needs no check of its own.
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
    // Run it here and put the state back, as canSplit does, and cache it in the
    // same place. Building a second Soksak copied the whole arrangement and
    // every option to answer yes or no, and a host asking about four sides on
    // every pointer move paid for all of it each time.
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
   * What every operation does when it is finished.
   *
   * A px size describes one slot. A card that comes to span two cannot be that
   * size, so the number is removed rather than kept for a later split to apply.
   */
  private changed(): void {
    // A trial split discards its state, so it must not clear the cache.
    if (!this.probing) this.splitMemo.clear();
    this.agreeSizes();
    this.sliceMemo.clear();
  }

  /**
   * Make every card in a slot declare the same px size, the largest asked for,
   * and drop a size from a card that no longer stands in one slot.
   *
   * A slot has one width, so two cards in it cannot ask for different ones.
   * `heldSizes` reads the largest, and this writes that back, so what `toJSON`
   * reports is what gets drawn. Run it wherever cards arrive or move.
   */
  private agreeSizes(): void {
    // A card that is gone leaves nothing to pay back, and a trial operation
    // that was rolled back leaves an entry for an id that never existed.
    if (this.paidBy.size) {
      const live = new Set(this.list.map((c) => c.id));
      for (const id of this.paidBy.keys()) if (!live.has(id)) this.paidBy.delete(id);
    }

    for (const card of this.list) {
      if (card.width !== undefined && card.c1 - card.c0 !== 1) delete card.width;
      if (card.height !== undefined && card.r1 - card.r0 !== 1) delete card.height;
    }
    for (const axis of AXES) {
      const [lo] = SPAN[axis];
      const agreed = heldSizes(this.plane, axis);
      for (const card of this.list) {
        if (fixedSize(card, axis) === null) continue;
        const size = agreed[card[lo]] as number;
        if (axis === 'x') card.width = size;
        else card.height = size;
      }
    }
  }

  /** Put the arrangement back to a state it reported earlier. */
  private restore(state: SoksakState): void {
    this.xs = [...state.xs];
    this.ys = [...state.ys];
    this.list = state.cards.map((c) => ({ ...c, fixed: c.fixed ?? false }));
    this.paidBy = new Map(Object.entries(state.paidBy ?? {}));
    this.agreeSizes();
    this.sliceMemo.clear();
    if (!this.probing) this.splitMemo.clear();
  }
}
