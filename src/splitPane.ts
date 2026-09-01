/**
 * A soksak over shared grid lines.
 *
 * Two arrays of numbers own every coordinate. A card is a span of indices into
 * them, so two cards that meet read the same index: a boundary is one number and
 * cannot drift apart. Moving a line moves every card that reads it; a card that
 * spans *across* the line is untouched, and for it the line is virtual —
 * invisible as a boundary, still there, and a later split snaps to it.
 *
 * Everything on the plane is a card. A sidebar at the window's edge is a card
 * holding the first column at a fixed width; the same card holding a middle
 * column is a rail standing between panes. Nothing can cross either, because a
 * card occupies its columns — the structure is the guarantee, so there is no
 * line to check and no tolerance to tune.
 *
 * Splitting only ever replaces one card with two, so the arrangement is always
 * slicing and every card stays closable. See `slicing.ts` for why that matters.
 */

import { AXES, SPAN, axisOf, fixedSize, isAhead, spanOf } from './card.js';
import type { Axis, Card, CardInit, Rect, Side } from './card.js';
import {
  boundarySpans,
  crossing,
  dividers,
  edgePos,
  inset,
  interiorLines,
  isVirtual,
  linePositions,
  rectOf,
  rules,
  slotSizes,
  zoneAt,
} from './geometry.js';
import type { Divider, Plane, Rule, Zone, ZoneHit, ZoneOptions } from './geometry.js';

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

  gap: number;
  minSize: number;
  grabSize: number;
  snapDistance: number;
  snap: SnapMode;
  fillOrder: FillOrder;

  /** Without a state, starts as one card filling the plane. */
  constructor(state?: SoksakState, options: SoksakOptions = {}) {
    this.gap = options.gap ?? 24;
    this.minSize = options.minSize ?? 96;
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
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  /**
   * Every card, as it stands.
   *
   * A copy, because this is a report and not a handle: writing to what came back
   * put cards into the grid and spans past the end of a line array without any
   * operation having run, and nothing downstream could tell.
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
   * `data` is opaque here and belongs to the host, which still has to be able to
   * change it — a tab moving between cards is the host's business, not a
   * rearrangement. Writing to what `card()` handed back used to be the only way,
   * which meant reaching into the state to do it.
   */
  setData(id: string, data: unknown): boolean {
    const card = this.find(id);
    if (!card) return false;
    card.data = data;
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
    return { xs: this.xs, ys: this.ys, cards: this.list, width: this.w, height: this.h, gap: this.gap };
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
    return new Map(this.list.map((c) => [c.id, this.rectOf(c)]));
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
   * The card a boundary resizes, if the slot on either side is held at a fixed
   * size. The card before it answers first, so dragging a sidebar's inner edge
   * resizes the sidebar rather than the pane beside it — one rule, so a drag is
   * never a guess.
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
    return dividers(this.plane, this.grabSize, (axis, line) => this.holderAt(axis, line)?.id);
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
   * How far a boundary may travel before some card would fall under `minSize`.
   *
   * A virtual line is a remembered position, not a constraint — nothing reads it,
   * so nothing is holding it there, and a drag reaches past it to the nearest
   * line a card actually uses. Letting it stop a drag was how a boundary between
   * two cards could refuse to centre between them.
   */
  /**
   * Whether `line` names a boundary between two slots.
   *
   * The plane's own borders are index 0 and the last, and they are not
   * boundaries anyone may move — moving one shortens the plane. An index past
   * the end names nothing at all.
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
      const near = this.inset(axis, card[lo], 'lo');
      const far = this.inset(axis, card[hi], 'hi');
      if (card[hi] === line) min = Math.max(min, along[card[lo]] + this.minSize + near + far);
      if (card[lo] === line) max = Math.min(max, along[card[hi]] - this.minSize - near - far);
    }
    return [min, max];
  }

  private inset(axis: Axis, index: number, side: 'lo' | 'hi'): number {
    const a = this.arr(axis);
    const flush = side === 'lo' ? index === 0 : index === a.length - 1;
    return flush ? 0 : this.gap / 2;
  }

  /**
   * Move a boundary to a position in px.
   *
   * What that means is a fact about what is beside it: next to a card holding
   * its slot at a fixed size it changes that size, and anywhere else it moves
   * the line, which every card reading it follows. One gesture either way.
   *
   * Returns where the boundary ended up.
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

    // A memory the move contradicts is no longer a memory of anything.
    line = this.forgetLinesPassed(axis, line, target);

    const holder = this.holderAt(axis, line);
    if (holder) {
      // Which edge of the holder is being dragged decides the arithmetic. Both
      // read positions from before the change: the edge that is *not* moving
      // stays where it is, and the size is the distance to it. Measuring from
      // the moving edge would be asking the size to define itself.
      const [lo, hi] = SPAN[axis];
      const along = linePositions(this.plane, axis);
      const slot =
        holder[hi] === line
          ? target - along[holder[lo]]   // its far edge moved; its start is fixed
          : along[holder[hi]] - target;  // its near edge moved; its end is fixed
      // `slot` is line to line. A fixed size is the drawn size, so the corridor
      // the slot carries comes back off — otherwise the boundary settles half a
      // corridor away from where it was dropped.
      const corridor =
        inset(this.plane, axis, holder[lo], 'lo') + inset(this.plane, axis, holder[hi], 'hi');
      const size = Math.max(0, slot - corridor);
      // A slot has one width. Setting it on the one card the drag happened to
      // find left any other card standing in the same slot still asking for the
      // old number, and the larger of the two won — so one of them was drawn at
      // a size it never asked for.
      for (const c of this.list) {
        if (c[lo] !== holder[lo] || fixedSize(c, axis) === null) continue;
        if (axis === 'x') c.width = size;
        else c.height = size;
      }
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
   * Drop the virtual lines a move passes, and say where the moved line ended up.
   *
   * A virtual line remembers where a boundary once was, so a later split can
   * land on it. Once a drag has gone past it, the position it remembers is on
   * the wrong side of the boundary that made it — there is nothing left to
   * remember, and keeping it would only mean the array is no longer in order.
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
    // `target` is px, so the comparison has to be too — the line array is
    // normalised, and mixing the two makes every line look passed.
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
   * Put a boundary where the two cards beside it come out the same size.
   *
   * Not the midpoint of the two lines — a card at the plane's border carries the
   * corridor inset on one side only, so centring the line leaves it half a
   * corridor wider than its neighbour.
   */
  centerBoundary(axis: Axis, line: number): number {
    // Centring divides what is shared. A fixed size is not shared — it is the
    // card's own answer — so a boundary beside one has no half to compute, and
    // making it "equal" to a pane would be answering a question nobody asked.
    if (!this.hasBoundary(axis, line) || this.holderAt(axis, line)) return this.boundaryPos(axis, line);

    const along = linePositions(this.plane, axis);
    const [lo, hi] = SPAN[axis];
    let start = along[line - 1] ?? 0;
    let end = along[line + 1] ?? this.size(axis);
    let insStart = this.inset(axis, line - 1, 'lo');
    let insEnd = this.inset(axis, line + 1, 'hi');
    for (const card of this.list) {
      if (card[hi] === line && along[card[lo]] >= start) {
        start = along[card[lo]];
        insStart = this.inset(axis, card[lo], 'lo');
      }
      if (card[lo] === line && along[card[hi]] <= end) {
        end = along[card[hi]];
        insEnd = this.inset(axis, card[hi], 'hi');
      }
    }
    return this.moveBoundary(axis, line, (start + end) / 2 + (insStart - insEnd) / 2, false);
  }

  /**
   * Fold a line onto a neighbour it now coincides with.
   *
   * Refused when a card spans the pair — that card would be left with no size,
   * and `minSize` keeps the state from arising in the first place.
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
   * Among the virtual lines the card spans, the one nearest its centre that
   * leaves both halves at least `minSize`; otherwise a new line at the centre,
   * pulled inside the range that fits. A single off-centre virtual line must
   * never lock a card that has room.
   */
  private cutAt(card: Card, axis: Axis): { line: number; value: number; snapped: boolean } | null {
    if (card.fixed) return null;
    // A card whose slot is held at a fixed size cannot be cut along that axis:
    // the size describes one slot, and two slots would need two answers.
    if (fixedSize(card, axis) !== null) return null;

    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    const per = this.sharedExtent(axis);
    if (per <= EPS) return null;

    const lowest = a[card[lo]] + (this.minSize + this.inset(axis, card[lo], 'lo') + this.gap / 2) / per;
    const highest = a[card[hi]] - (this.minSize + this.gap / 2 + this.inset(axis, card[hi], 'hi')) / per;
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

  /** True when both halves would keep `minSize`. */
  canSplit(id: string, axis: Axis): boolean {
    const card = this.find(id);
    return !!card && !!this.cutAt(card, axis);
  }

  /**
   * Cut one card in two.
   *
   * The original keeps its identity and its near half, so a live surface it owns
   * survives; the new card takes the far half. Cards that span the new line only
   * widen their span — they are not cut.
   *
   * The new card carries no `data` unless you give it some. A host that hangs a
   * payload on its cards has to answer for the new one, and copying the source's
   * would hand two cards one surface. A fixed size on the *other* axis rides
   * along, because both halves still stand in that slot.
   *
   * Returns the new card's id, or null when there was no room.
   */
  split(id: string, axis: Axis, init: { id?: string; data?: unknown } = {}): string | null {
    const card = this.find(id);
    const cut = card && this.cutAt(card, axis);
    if (!card || !cut) return null;
    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];

    let line = cut.line;
    if (line < 0) {
      // The cut falls strictly inside this card, so the new line belongs
      // strictly inside its span. Searching the whole array instead found an
      // index outside the card as soon as two lines shared a coordinate, and a
      // card cannot be cut by a line it does not reach.
      line = card[lo] + 1;
      while (line < card[hi] && a[line] <= cut.value + EPS) line++;
      a.splice(line, 0, cut.value);
      for (const other of this.list) {
        if (other[lo] >= line) other[lo]++;
        if (other[hi] >= line) other[hi]++;
      }
    }

    const across: Axis = axis === 'x' ? 'y' : 'x';
    const fresh: Card = {
      id: init.id ?? this.nextId(),
      c0: card.c0,
      c1: card.c1,
      r0: card.r0,
      r1: card.r1,
      fixed: false,
      data: init.data,
    };
    const held = fixedSize(card, across);
    if (held !== null) {
      if (across === 'x') fresh.width = held;
      else fresh.height = held;
    }
    fresh[lo] = line;
    card[hi] = line;
    this.list.push(fresh);
    this.changed();
    return fresh.id;
  }

  /**
   * Cut a card and put the new one on a named side.
   *
   * `split` always hands the far half to the new card, so `left` and `top` have
   * the two exchange the halves they hold. What is exchanged is the *span* — a
   * card's identity stays with the card, because a host that is holding one and
   * finds its id changed underneath has no way to notice.
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
   * The axis along which this card's slots are its own, if any.
   *
   * A card reaching from one side of the plane to the other holds every slot it
   * spans by itself — nobody else is in them. So it can leave without anyone
   * growing: the slots go, the cards on either side meet, and the sharing cards
   * take the room back.
   *
   * That is the only way out for a card hemmed in by fixed ones. A fixed card's
   * size is its own, so it never fills a gap, and a card between two of them
   * could otherwise be neither closed nor moved. How many slots it spans makes
   * no difference — one or three, they are all its own.
   */
  private soleSlots(card: Card): Axis | null {
    for (const axis of AXES) {
      const [lo, hi] = SPAN[axis];
      // The slots go, and every card reaching into them shrinks to what is
      // left. That is well defined unless some other card lives *entirely*
      // inside the range, because then it would be left spanning nothing.
      // Asking whether this card reaches across the plane was a narrower
      // question with the same answer in the easy cases, and no answer at all
      // for a card hemmed in on both axes by cards holding a px size.
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

  /**
   * Whether every axis still has a slot that no card holds at a px size.
   *
   * Held slots take their px off the top and the rest share what is left. If
   * nothing is left to share, nothing stretches to the plane's edge and the
   * held sizes simply do not add up to it — a 40px card alone on an 800px
   * plane, with the other 760 belonging to no one.
   */
  private someoneShares(): boolean {
    for (const axis of AXES) {
      const [lo] = SPAN[axis];
      const held = new Set<number>();
      for (const card of this.list) if (fixedSize(card, axis) !== null) held.add(card[lo]);
      if (held.size >= this.arr(axis).length - 1) return false;
    }
    return true;
  }

  canClose(id: string): boolean {
    const card = this.removable(id);
    if (!card) return false;
    if (!this.fill(id) && this.soleSlots(card) === null) return false;
    const before = this.toJSON();
    const done = this.close(id);
    this.restore(before);
    return done;
  }

  /**
   * Remove a card.
   *
   * A neighbour grows into the space when one can. When none can, the card's own
   * slot goes instead — well defined exactly when it filled that slot alone.
   */
  close(id: string): boolean {
    const card = this.removable(id);
    if (!card) return false;
    const before = this.toJSON();

    const filling = this.fill(id);
    if (filling) {
      for (const neighbour of filling.cards) neighbour[filling.grow] = card[filling.grow];
      this.list.splice(this.list.indexOf(card), 1);
      this.changed();
      if (!this.someoneShares()) {
        this.restore(before);
        return false;
      }
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
    if (!this.someoneShares()) {
      this.restore(before);
      return false;
    }
    return true;
  }

  /**
   * Whether a card reaching across the whole plane can stand on this boundary.
   *
   * It can when no card spans over it. That is a fact about the spans — integers
   * — not a comparison of coordinates, so there is no tolerance to tune and
   * nothing to repair afterwards. Dragging a boundary can never change the
   * answer; only splitting and closing can.
   */
  canInsertAt(axis: Axis, line: number): boolean {
    const a = this.arr(axis);
    if (!Number.isInteger(line) || line < 0 || line > a.length - 1) return false;
    return this.cardsCrossing(axis, line).length === 0;
  }

  /**
   * Put a card at a boundary, reaching across the whole plane.
   *
   * This is the operation `splitToward` is not. Splitting cuts one card, so the
   * new one inherits that card's extent — a rail made that way would stand in
   * one row and be a pane like any other. A card that separates everything from
   * everything has to be inserted at a boundary nothing crosses, and every card
   * past it moves along.
   *
   * `size` is required and is px. A card inserted this way stands in a slot of
   * its own that no proportion describes — it separates everything from
   * everything, so there is no card to halve and no share to inherit. Without a
   * size there is no answer to how wide it is, and the card came out with no
   * width at all.
   *
   * Returns the new card's id, or null when a card spans the boundary.
   */
  insertAt(axis: Axis, line: number, init: { id?: string; data?: unknown; size: number }): string | null {
    if (!Number.isFinite(init?.size) || init.size < 0) return null;
    if (!this.canInsertAt(axis, line)) return null;
    const [lo, hi] = SPAN[axis];
    const across: Axis = axis === 'x' ? 'y' : 'x';
    const [alo, ahi] = SPAN[across];

    this.openSlot(axis, line);

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
    this.changed();
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
   * Open a slot at a boundary.
   *
   * The coordinate is duplicated, so the new slot has no share of its own and
   * takes its size from the card that will hold it. A card that *ends* at the
   * boundary keeps ending there — the slot opens after it — while one that
   * starts there moves along. Getting that asymmetry wrong is how a card ends up
   * spanning the slot it was supposed to make room for.
   */
  private openSlot(axis: Axis, line: number): void {
    const a = this.arr(axis);
    const [lo, hi] = SPAN[axis];
    a.splice(line, 0, a[line]);
    for (const card of this.list) {
      if (card[lo] >= line) card[lo]++;
      if (card[hi] > line) card[hi]++;
    }
  }

  /**
   * Take a slot out of the axis. The cards on either side meet where it was.
   *
   * A slot is bounded by two lines and exactly one of them is interior, so that
   * is the one that goes: the far line normally, and the near one for the last
   * slot, whose far line is the plane's own border. Taking the border instead
   * shortens the plane, and every position after that is measured against an
   * edge that moved.
   */
  private dropSlot(axis: Axis, slot: number): void {
    const a = this.arr(axis);
    if (a.length <= 2) return; // one slot, no interior line, nothing to take
    const [lo, hi] = SPAN[axis];
    const gone = slot + 1 < a.length - 1 ? slot + 1 : slot;
    a.splice(gone, 1);
    for (const card of this.list) {
      // A card that *started* at the line falls back to the one before it; a
      // card that *ended* there reaches on to the next. Either way it takes the
      // freed room, and neither can be written as the other.
      if (card[lo] >= gone) card[lo]--;
      if (card[hi] > gone) card[hi]--;
    }
  }

  /**
   * Take a plane-spanning card to another boundary.
   *
   * Its column leaves and a column arrives — nothing is closed and nothing is
   * split, so no other card's spans change and no boundary on the other axis
   * moves at all. Travelling that way is the difference between a rail moving
   * and a layout being rearranged around it.
   *
   * `line` is a boundary in the arrangement as it stands now.
   */
  moveTo(id: string, axis: Axis, line: number): boolean {
    const card = this.find(id);
    // `fixed` says the *layout* does not move it, and this is not the layout: it
    // names the card, changes no other card's spans and no line on the other
    // axis. A rail is fixed and travelling is what a rail does. `move` refuses a
    // fixed card because a drop rearranges everything around it; this does not.
    if (!card || !this.spansPlane(card, axis)) return false;
    const [lo, hi] = SPAN[axis];
    const from = card[lo];
    if (line === from || line === card[hi]) return true;   // already there

    const before = this.toJSON();
    this.list.splice(this.list.indexOf(card), 1);
    this.dropSlot(axis, from);

    // The target boundary shifted down by one if it stood past the slot that left.
    const target = line > from + 1 ? line - 1 : line;
    if (!this.canInsertAt(axis, target)) {
      this.restore(before);
      return false;
    }
    this.openSlot(axis, target);
    const across: Axis = axis === 'x' ? 'y' : 'x';
    const [alo, ahi] = SPAN[across];
    card[lo] = target;
    card[hi] = target + 1;
    card[alo] = 0;
    card[ahi] = this.arr(across).length - 1;
    this.list.push(card);
    this.changed();
    if (!this.someoneShares()) {
      this.restore(before);
      return false;
    }
    return true;
  }

  /** Every boundary a plane-spanning card could stand on. */
  standings(axis: Axis): number[] {
    const out: number[] = [];
    for (const k of interiorLines(this.plane, axis)) if (this.canInsertAt(axis, k)) out.push(k);
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
    if (!this.someoneShares()) {
      // The card brought its px size to a slot that was the last one sharing.
      this.restore(before);
      return false;
    }
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
    for (const card of this.list) {
      if (card.width !== undefined && card.c1 - card.c0 !== 1) delete card.width;
      if (card.height !== undefined && card.r1 - card.r0 !== 1) delete card.height;
    }
    // Two cards can end up in one slot asking for different widths. The slot has
    // one, so they agree on the larger and both are drawn at what they hold.
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
  }
}
