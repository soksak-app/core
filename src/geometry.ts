/**
 * Coordinate computation.
 *
 * `xs` and `ys` hold every position, normalised 0..1 over the slots that share
 * the remaining space. A slot with a px size is drawn at that size whatever its
 * span, so a line's px position is not its value times the plane size. A card is
 * a span of indices into them, so two cards that meet reference the same index.
 *
 * Every function here is pure and takes the plane as an argument.
 */

import { AXES, SPAN, fixedSize, other } from './card.js';
import type { Axis, Card, Rect, Side } from './card.js';

/** Everything a coordinate depends on. */
export interface Plane {
  xs: number[];
  ys: number[];
  cards: readonly Card[];
  width: number;
  height: number;
  /** Gap between two cards, in px. Half of it insets every inner edge. */
  gap: number;
  /** Minimum card size, in px. */
  minSize: number;
}

const lines = (plane: Plane, axis: Axis): number[] => (axis === 'x' ? plane.xs : plane.ys);
const extent = (plane: Plane, axis: Axis): number => (axis === 'x' ? plane.width : plane.height);

/**
 * The gap a slot holds: half a gap for every card edge that insets into it.
 *
 * Lines at one position form one boundary, and a zero-width slot cannot hold a
 * gap, so the cost falls on the nearest slot that can. Two lines of a run can
 * each place an edge here, and one half gap covers both, so the run takes the
 * largest value rather than the sum.
 */
export function corridorOf(
  plane: Plane,
  axis: Axis,
  slot: number,
  read = linesRead(plane, axis),
): number {
  const a = lines(plane, axis);
  if (blank(plane, axis, slot)) return 0;
  let lo = inset(plane, axis, slot, 'lo', read);
  for (let k = slot - 1; k >= 0 && blank(plane, axis, k); k--) {
    lo = Math.max(lo, inset(plane, axis, k, 'lo', read));
  }
  let hi = inset(plane, axis, slot + 1, 'hi', read);
  for (let k = slot + 2; k < a.length && blank(plane, axis, k - 1); k++) {
    hi = Math.max(hi, inset(plane, axis, k, 'hi', read));
  }
  return lo + hi;
}

/**
 * The corridor a slot holds once it has a width.
 *
 * A slot standing at zero width carries none: the slot beside the run holds it,
 * because a slot with no width has nothing to carry one with. A caller about to
 * give such a slot a width needs the corridor it will then hold, not the zero it
 * holds now.
 */
export function corridorWhenWide(
  plane: Plane,
  axis: Axis,
  slot: number,
  read = linesRead(plane, axis),
): number {
  if (!blank(plane, axis, slot)) return corridorOf(plane, axis, slot, read);
  const a = lines(plane, axis);
  const half = halfCorridor(plane, axis, read);
  // `inset` reads the plane as it stands, where this slot is one of a run and the
  // scan passes through it, so a run reaching a border answers 0 for the slot
  // that is about to carry the corridor. Once it has width its own two lines
  // inset into it, and those two terms are read off the lines instead.
  let lo = slot === 0 || !read.has(slot) ? 0 : half;
  let hi = slot + 1 === a.length - 1 || !read.has(slot + 1) ? 0 : half;
  // The slots still standing at zero width place their edges here too, and one
  // half gap covers a whole run, so the run takes the largest rather than the
  // sum — the rule `corridorOf` follows.
  for (let k = slot - 1; k >= 0 && blank(plane, axis, k); k--) {
    lo = Math.max(lo, k === 0 || !read.has(k) ? 0 : half);
  }
  for (let k = slot + 2; k < a.length && blank(plane, axis, k - 1); k++) {
    hi = Math.max(hi, k === a.length - 1 || !read.has(k) ? 0 : half);
  }
  return lo + hi;
}

/**
 * True when a slot draws at zero width: no span to take a share with and no px
 * size. The two lines around it land at the same position.
 *
 * The cards are scanned only when a slot has no span, which is rare, so a plane
 * with no coincident lines costs one subtraction per call.
 */
function blank(plane: Plane, axis: Axis, slot: number): boolean {
  const a = lines(plane, axis);
  if (a[slot + 1] - a[slot] >= 1e-9) return false;
  const [lo] = SPAN[axis];
  for (const card of plane.cards) {
    if (card[lo] === slot && fixedSize(card, axis) !== null) return false;
  }
  return true;
}

/** The px size each slot declares: the largest value any card in it sets. */
export function heldSizes(plane: Plane, axis: Axis): (number | null)[] {
  const [lo] = SPAN[axis];
  const held = new Array<number | null>(lines(plane, axis).length - 1).fill(null);
  for (const card of plane.cards) {
    const size = fixedSize(card, axis);
    if (size === null) continue;
    held[card[lo]] = Math.max(held[card[lo]] ?? 0, size);
  }
  return held;
}

/** Drawn width of every slot, gap removed. */
export function slotWidths(plane: Plane, axis: Axis): number[] {
  const read = linesRead(plane, axis);
  return slotSizes(plane, axis).map((size, i) => size - corridorOf(plane, axis, i, read));
}

/**
 * What the slots on an axis ask of the plane.
 *
 * `asked` is the px the slots with a size declare, `taken` the corridor those
 * slots carry on top, `sharedSpan` how much span the rest divide, and `floor`
 * the least the rest can take. The plane holds the declared sizes when
 * `sharedSpan` is zero or `extent - asked - taken` is at least `floor`.
 */
function demand(plane: Plane, axis: Axis): {
  asked: number;
  taken: number;
  sharedSpan: number;
  floor: number;
} {
  const a = lines(plane, axis);
  const count = a.length - 1;
  const read = linesRead(plane, axis);
  const held = heldSizes(plane, axis);
  let asked = 0;
  let taken = 0;
  let sharedSpan = 0;
  let floor = 0;
  for (let i = 0; i < count; i++) {
    if (held[i] !== null) {
      asked += held[i] as number;
      taken += corridorOf(plane, axis, i, read);
    } else {
      sharedSpan += a[i + 1] - a[i];
      floor += corridorOf(plane, axis, i, read);
    }
  }
  if (sharedSpan > 1e-9) floor += plane.minSize;
  return { asked, taken, sharedSpan, floor };
}

/**
 * Whether the plane holds what the slots on this axis declare.
 *
 * When it does not, every declared size is drawn scaled by one factor. A slot
 * that shares is the one that gives the room up, so an axis where none shares
 * never holds them: the declared numbers are proportions there.
 */
export function holdsSizes(plane: Plane, axis: Axis): boolean {
  const { asked, taken, sharedSpan, floor } = demand(plane, axis);
  return sharedSpan > 1e-9 && extent(plane, axis) - asked - taken >= floor;
}

/**
 * The px size a slot has to declare to be drawn `drawn` px wide.
 *
 * While the plane holds what the slots declare, that is `drawn` itself. When it
 * does not, every declared size is drawn scaled by one factor, so the size read
 * off the plane is smaller than the size that produced it: writing the read size
 * back would shrink the declaration on every drag, including one that moves
 * nothing.
 *
 * In that regime the slot is drawn `d * left / (other + d)`, where `other` is
 * what the remaining slots declare and `left` is the px the scaled sizes divide.
 * Solving it for `d` gives the size below. `left` does not depend on any
 * declared size, so one slot's declaration is enough to solve.
 *
 * Two cases have no answer and keep the size the slot declares now: no other
 * slot declares one, which makes the drawn size the same whatever this slot
 * declares, and a request of `left` or more, which no declaration reaches.
 */
export function declaredFor(plane: Plane, axis: Axis, slot: number, drawn: number): number {
  // The slot declares a size: the only caller reads one off the card whose px
  // size a drag at this boundary changes.
  const now = heldSizes(plane, axis)[slot] as number;
  // The size declared now already draws at the width asked for. More than one
  // declaration draws at a given width once the sizes are scaled, and this is
  // the one to keep: a drag that does not move the boundary changes nothing.
  if (Math.abs(slotWidths(plane, axis)[slot] - drawn) <= 1e-9) return now;
  const { asked, taken, sharedSpan, floor } = demand(plane, axis);
  const room = extent(plane, axis);
  // The plane holds the sizes once this slot declares `drawn`. The comparison
  // carries the same slack every other comparison here does: at the end of the
  // range `boundaryRange` reports, the two sides are equal, and `drawn` is
  // measured from a line position that accumulates one rounding per slot. A
  // strict comparison refuses the last position the range names, and the drag
  // that asked for it moves nothing.
  if (sharedSpan > 1e-9 && room - (asked - now + drawn) - taken >= floor - 1e-9) return drawn;

  const other = asked - now;
  const keep = Math.min(floor, Math.max(0, room - taken));
  const left = Math.max(0, room - keep - taken);
  if (other <= 1e-9 || drawn >= left - 1e-9) return now;
  return Math.max(drawn, (drawn * other) / (left - drawn));
}

/**
 * Width in px of every slot on an axis.
 *
 * A slot with a px size takes that size; the rest divide the remainder in
 * proportion to their spans, down to `minSize` each.
 *
 * When the px sizes do not fit, they are scaled by one factor so the slots still
 * sum to the plane size.
 */
export function slotSizes(plane: Plane, axis: Axis): number[] {
  return divide(plane, axis).size;
}

/**
 * The px a sharing slot is drawn at per unit of its span.
 *
 * A boundary between two sharing slots moves by changing span, and this is what
 * one unit of span is worth. A slot the starvation rule stopped at its corridor
 * does not flex with its span and is not counted, so a move measured against
 * this rate lands where it was asked to.
 */
export function sharePerSpan(plane: Plane, axis: Axis): number {
  return divide(plane, axis).each;
}

/** The size of every slot on an axis, and what one unit of shared span is worth. */
function divide(plane: Plane, axis: Axis): { size: number[]; each: number } {
  const a = lines(plane, axis);
  const count = a.length - 1;

  // The slot holds the gap, so a px size is the drawn width.
  const read = linesRead(plane, axis);        // one pass, not one per slot
  const corridor = new Array<number>(count);
  for (let i = 0; i < count; i++) corridor[i] = corridorOf(plane, axis, i, read);

  // What each slot requires: the px size its cards declare, or none, in which
  // case it shares the remainder.
  const held = heldSizes(plane, axis);

  let asked = 0;      // px the held slots were told to be
  let taken = 0;      // corridor those slots carry on top
  let sharedSpan = 0; // how the rest divide what is left
  let floor = 0;      // corridor the sharing slots carry
  for (let i = 0; i < count; i++) {
    if (held[i] !== null) {
      asked += held[i] as number;
      taken += corridor[i];
    } else {
      sharedSpan += a[i + 1] - a[i];
      floor += corridor[i];
    }
  }
  // Plus one card's minimum between them. Counting per slot would overcount a
  // card that spans several.
  if (sharedSpan > 1e-9) floor += plane.minSize;

  const usable = extent(plane, axis) - asked - taken;
  if (sharedSpan > 1e-9 && usable >= floor) {
    const size = held.map((fixed, i) => (fixed !== null ? fixed + corridor[i] : 0));

    // Divide `usable` by span, but no card is drawn narrower than the corridor
    // its slots hold. Such a card is drawn at zero width and places its
    // neighbours closer than one gap. The first of its slots that still shares
    // stops at the gap it holds and the rest divide the remainder, so only a
    // plane too small for its contents is affected.
    //
    // The measure is the card, not the slot: a card drawn across several slots
    // takes its corridor out of all of them together, and charging one slot that
    // the card spans past would move every other card instead.
    const [lo, hi] = SPAN[axis];
    const stopped = new Array<boolean>(count).fill(false);
    // The slots between two lines the cards read are one slot to every card: a
    // line is read only where a card starts or ends, so no card starts or ends
    // inside such a run and every card covering one of its slots covers all of
    // them. A stop that took part of a run let a cut no card reads decide how
    // much room the stop released, so the same arrangement was drawn one way
    // with the cut and another way without it, and `tidy` moved cards.
    const runFrom = new Array<number>(count);
    const runTo = new Array<number>(count);
    for (let i = 0; i < count; ) {
      let end = i + 1;
      while (end < count && !read.has(end)) end++;
      for (let k = i; k < end; k++) {
        runFrom[k] = i;
        runTo[k] = end;
      }
      i = end;
    }
    let room = usable;
    let pool = sharedSpan;
    for (;;) {
      // Divided by the span that is left, which is never none: the rule never
      // picks the slot that would take the last of it, because a card holding
      // only that slot is already drawn the whole of `room`. Reading the span
      // against a tolerance instead took a pool of 9e-10 for none and gave the
      // room the stop released to no slot at all.
      const each = room / pool;
      let starved = -1;
      for (const card of plane.cards) {
        let fixed = 0;   // px its slots already stand at
        let span = 0;    // span its remaining slots divide
        let need = 0;    // corridor those slots hold
        let first = -1;  // the slot to stop
        for (let i = card[lo]; i < card[hi]; i++) {
          need += corridor[i];
          if (held[i] !== null || stopped[i]) {
            fixed += size[i];
            continue;
          }
          span += a[i + 1] - a[i];
          if (first < 0) first = i;
        }
        if (first >= 0 && fixed + span * each < need - 1e-9) {
          starved = first;
          break;
        }
      }
      if (starved < 0) {
        for (let i = 0; i < count; i++) {
          if (held[i] !== null || stopped[i]) continue;
          size[i] = (a[i + 1] - a[i]) * each;
        }
        return { size, each };
      }
      // `usable` is at least the gaps plus one card minimum, so stopping every
      // slot at its gap still leaves size and span to divide. The whole run
      // stops, because the cards read its two ends and nothing inside it.
      for (let i = runFrom[starved]; i < runTo[starved]; i++) {
        if (held[i] !== null || stopped[i]) continue;
        stopped[i] = true;
        size[i] = corridor[i];
        room -= corridor[i];
        pool -= a[i + 1] - a[i];
      }
    }
  }

  // The requested sizes do not fit, or no slot shares. The sharing slots keep
  // their floor and the px sizes scale by one factor, preserving their
  // proportions. A sidebar then narrows with the window instead of pushing the
  // panes below `minSize` or extending past the plane, and a closing card always
  // has a slot to give its space to.
  const keep = Math.min(floor, Math.max(0, extent(plane, axis) - taken));
  const left = Math.max(0, extent(plane, axis) - keep - taken);
  const scale = asked > 1e-9 ? left / asked : 0;
  // A sharing slot takes its gap first, then a share of the remainder.
  let floors = 0;
  for (let i = 0; i < count; i++) if (held[i] === null) floors += corridor[i];
  const spare = Math.max(0, keep - floors);
  const each = sharedSpan > 1e-9 ? spare / sharedSpan : 0;
  // Every declared size is zero, so there is no proportion to scale. The slots
  // still sum to the plane, so they divide what is left by span.
  if (asked <= 1e-9) {
    let heldSpan = 0;
    let heldSlots = 0;
    for (let i = 0; i < count; i++) {
      if (held[i] === null) continue;
      heldSpan += a[i + 1] - a[i];
      heldSlots++;
    }
    return {
      each,
      size: held.map((fixed, i) =>
        fixed !== null
          ? corridor[i] +
            (heldSpan > 1e-9 ? (left * (a[i + 1] - a[i])) / heldSpan : left / heldSlots)
          : corridor[i] + (a[i + 1] - a[i]) * each,
      ),
    };
  }
  return {
    each,
    size: held.map((fixed, i) =>
      fixed !== null ? fixed * scale + corridor[i] : corridor[i] + (a[i + 1] - a[i]) * each,
    ),
  };
}

/** Every line position in px, index for index with the line array. */
export function linePositions(plane: Plane, axis: Axis): number[] {
  const sizes = slotSizes(plane, axis);
  const out = [0];
  for (const size of sizes) out.push(out[out.length - 1] + size);
  return out;
}

/** How far a card's edge insets from its line: half a gap, or 0 at a border. */
/**
 * Gap width for this axis, capped at what the plane can hold.
 *
 * Each interior line that a card references costs one gap. When the total
 * exceeds the plane size, the gap is reduced to fit. Every slot is at least the
 * gap it holds; a card whose own lines are at one position has zero width, and
 * `rectIn` places it accordingly.
 */
function corridor(plane: Plane, axis: Axis, read = linesRead(plane, axis)): number {
  const a = lines(plane, axis);
  // Counted from the set rather than scanned: every card span is an index into
  // the lines, so the interior ones are the set minus whichever borders it
  // contains. `inset` calls this once per line.
  let real = read.size;
  if (read.has(0)) real--;
  if (read.has(a.length - 1)) real--;
  if (real <= 0) return plane.gap;
  return Math.min(plane.gap, Math.max(0, extent(plane, axis)) / real);
}

/** Line indices that at least one card references. One pass over the cards. */
export function linesRead(plane: Plane, axis: Axis): Set<number> {
  const [lo, hi] = SPAN[axis];
  const read = new Set<number>();
  for (const card of plane.cards) {
    read.add(card[lo]);
    read.add(card[hi]);
  }
  return read;
}

/**
 * How far a card's edge insets from the line it references.
 *
 * `read` is the set of lines any card references. Computing it costs one pass
 * over the cards, so a caller that needs many lines computes it once and passes
 * it in. Without that, a loop over N cards scans the cards N times.
 */
export function inset(
  plane: Plane,
  axis: Axis,
  index: number,
  side: 'lo' | 'hi',
  read = linesRead(plane, axis),
): number {
  const a = lines(plane, axis);
  const flush = side === 'lo' ? index === 0 : index === a.length - 1;
  if (flush) return 0;
  // A line no card references separates nothing and takes no gap.
  if (!read.has(index)) return 0;
  // Lines at one position form one boundary. The card on this side has its size
  // in the first slot past the zero-width ones, so the run is scanned rather
  // than treated as one slot: a card spanning coincident lines still insets half
  // a gap from what it meets. A run ending at the plane's edge has nothing to
  // inset into and the card there is drawn against the border.
  const step = side === 'lo' ? 1 : -1;
  let slot = side === 'lo' ? index : index - 1;
  while (slot >= 0 && slot <= a.length - 2 && blank(plane, axis, slot)) slot += step;
  if (slot < 0 || slot > a.length - 2) return 0;
  return corridor(plane, axis, read) / 2;
}

/** Half the gap a referenced line takes, capped at what the plane can hold. */
export function halfCorridor(plane: Plane, axis: Axis, read = linesRead(plane, axis)): number {
  return corridor(plane, axis, read) / 2;
}

/** Line positions and edge insets for one axis. */
export interface Axle {
  at: number[];
  /** How far a card starting at each line insets from it. */
  lo: number[];
  /** How far a card ending at each line insets from it. */
  hi: number[];
}

/** Frames for both axes. */
export interface Frame {
  x: Axle;
  y: Axle;
}

/**
 * Line positions and edge insets for both axes.
 *
 * Computed once and passed to `rectIn`, so placing N cards is O(N) rather than
 * O(N squared).
 */
export function frameOf(plane: Plane): Frame {
  const axle = (axis: Axis): Axle => {
    const a = lines(plane, axis);
    const read = linesRead(plane, axis);       // one pass, not one per line
    const sizes = slotSizes(plane, axis);
    const at = [0];
    for (const size of sizes) at.push(at[at.length - 1] + size);
    // Delegated to `inset` rather than recomputed. A second copy of the rule
    // produced a different result over coincident lines.
    const lo = a.map((_, i) => inset(plane, axis, i, 'lo', read));
    const hi = a.map((_, i) => inset(plane, axis, i, 'hi', read));
    return { at, lo, hi };
  };
  return { x: axle('x'), y: axle('y') };
}

/** Rect of one card from a precomputed frame. */
export function rectIn(frame: Frame, card: Card): Rect {
  const [x, w] = span(frame.x, card.c0, card.c1);
  const [y, h] = span(frame.y, card.r0, card.r1);
  return { x, y, w, h };
}

/**
 * One axis of a rect: the card's start position and size.
 *
 * A card whose two lines are at one position has its far edge before its near
 * one. It has no size there, so it is drawn at zero width in the middle of the
 * slots it spans rather than inverted. That position is where its lines are,
 * inside the single gap separating the cards on either side of the run.
 */
function span(axle: Axle, lo: number, hi: number): [number, number] {
  const near = axle.at[lo] + axle.lo[lo];
  const far = axle.at[hi] - axle.hi[hi];
  // A card clamped to exactly zero width lands a rounding on either side of its
  // near edge. Treating that as inverted would move it to the middle of its
  // slots and make the gap before it slightly under one gap.
  if (far >= near - 1e-6) return [near, Math.max(0, far - near)];
  return [(axle.at[lo] + axle.at[hi]) / 2, 0];
}

/** The rect of one card. Every rect in the library is computed here. */
export function rectOf(plane: Plane, card: Card): Rect {
  return rectIn(frameOf(plane), card);
}

/** Cards that span across a line. Their presence blocks placement on it. */
export function crossing(plane: Plane, axis: Axis, line: number): Card[] {
  const [lo, hi] = SPAN[axis];
  return plane.cards.filter((c) => c[lo] < line && c[hi] > line);
}

/**
 * Cards indexed by the line they end at and the line they start at.
 *
 * Built once per axis so `boundarySpans` pairs only the cards that meet at a
 * line rather than every card with every other card.
 */
export interface Touching {
  ends: Map<number, Card[]>;
  starts: Map<number, Card[]>;
}

export function touching(plane: Plane, axis: Axis): Touching {
  const [lo, hi] = SPAN[axis];
  const ends = new Map<number, Card[]>();
  const starts = new Map<number, Card[]>();
  const push = (m: Map<number, Card[]>, k: number, c: Card): void => {
    const at = m.get(k);
    if (at) at.push(c);
    else m.set(k, [c]);
  };
  for (const card of plane.cards) {
    push(ends, card[hi], card);
    push(starts, card[lo], card);
  }
  return { ends, starts };
}

/**
 * Index stretches where cards actually break on a line.
 *
 * A line runs the whole plane but is a boundary only where one card ends and
 * another begins. Elsewhere a card spans across it, so there is nothing to drag
 * and nothing to draw solid.
 */
export function boundarySpans(
  plane: Plane,
  axis: Axis,
  line: number,
  meet: Touching = touching(plane, axis),
): [number, number][] {
  const [o0, o1] = SPAN[other(axis)];
  // The spans the cards ending here cover, intersected with the spans the cards
  // starting here cover. Comparing each pair directly gives the same result but
  // costs one comparison per card pair.
  const before = cover(meet.ends.get(line), o0, o1);
  const after = cover(meet.starts.get(line), o0, o1);

  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const start = Math.max(before[i][0], after[j][0]);
    const end = Math.min(before[i][1], after[j][1]);
    if (end > start) out.push([start, end]);
    if (before[i][1] < after[j][1]) i++;
    else j++;
  }
  return out;
}

/** The spans a set of cards covers on the other axis, sorted and merged. */
function cover(
  cards: Card[] | undefined,
  o0: 'c0' | 'r0',
  o1: 'c1' | 'r1',
): [number, number][] {
  if (!cards?.length) return [];
  const spans = cards.map((c): [number, number] => [c[o0], c[o1]]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [spans[0]];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}

/** True when no card references this line. */
export function isVirtual(
  plane: Plane,
  axis: Axis,
  line: number,
  read = linesRead(plane, axis),
): boolean {
  return !read.has(line);
}

/** Interior line indices. The two borders are excluded. */
export function interiorLines(plane: Plane, axis: Axis): number[] {
  const a = lines(plane, axis);
  const out: number[] = [];
  for (let k = 1; k < a.length - 1; k++) out.push(k);
  return out;
}

/** A boundary to draw. One virtual rule per line, plus its solid stretches. */
export interface Rule extends Rect {
  key: string;
  axis: Axis;
  line: number;
  virtual: boolean;
}

/** Hit area for dragging a boundary. */
export interface Divider extends Rect {
  key: string;
  axis: Axis;
  line: number;
}

/**
 * The rules to draw for every boundary.
 *
 * A line runs the whole plane, so it produces one rule of that length. It is a
 * boundary only where cards break on it, so each of those stretches produces a
 * solid rule. Draw the first faintly and the second at full strength.
 */
export function rules(plane: Plane): Rule[] {
  const out: Rule[] = [];
  const frame = frameOf(plane);
  for (const axis of AXES) {
    const along = frame[axis].at;
    const across = axis === 'x' ? plane.height : plane.width;
    const down = other(axis);
    // The drawn gap, not the declared one, and the one on the axis the rule runs
    // along: a plane too narrow for the declared gap draws a smaller one there,
    // and a rule extended by the other axis's gap misses the corridor it reaches.
    const half = halfCorridor(plane, down);
    const meet = touching(plane, axis);
    const read = linesRead(plane, axis);
    // A rule stays inside the plane. Extending it half a gap past each end made
    // the host scroll, because the view places these in the host's element.
    const hold = (v: number): number => Math.min(Math.max(v, 0), across);
    for (const line of interiorLines(plane, axis)) {
      // A line no card reads has no card edge anywhere along it. The line stays
      // in the array, because it is what a card that paid for its slot comes
      // back to, but there is nothing to draw for it. `dividers` already yields
      // nothing there.
      if (isVirtual(plane, axis, line, read)) continue;
      const at = along[line] - 0.5;
      out.push(
        axis === 'x'
          ? { key: `vx:${line}`, axis, line, virtual: true, x: at, y: 0, w: 1, h: across }
          : { key: `vy:${line}`, axis, line, virtual: true, x: 0, y: at, w: across, h: 1 },
      );
      for (const [from, to] of boundarySpans(plane, axis, line, meet)) {
        const start = hold(frame[down].at[from] + frame[down].lo[from] - half);
        const end = hold(frame[down].at[to] - frame[down].hi[to] + half);
        out.push(
          axis === 'x'
            ? { key: `sx:${line}:${from}`, axis, line, virtual: false, x: at, y: start, w: 1, h: end - start }
            : { key: `sy:${line}:${from}`, axis, line, virtual: false, x: start, y: at, w: end - start, h: 1 },
        );
      }
    }
  }
  return out;
}

/**
 * The draggable area of a boundary.
 *
 * Only where cards break on the line. Elsewhere a card spans across it and there
 * is nothing to drag. The hit area is independent of the gap so a zero gap is
 * still draggable.
 */
export function dividers(plane: Plane, grabSize: number): Divider[] {
  const out: Divider[] = [];
  const hit = Math.max(plane.gap, grabSize);
  const frame = frameOf(plane);
  for (const axis of AXES) {
    const along = frame[axis].at;
    const down = other(axis);
    const meet = touching(plane, axis);
    for (const line of interiorLines(plane, axis)) {
      for (const [from, to] of boundarySpans(plane, axis, line, meet)) {
        const start = frame[down].at[from] + frame[down].lo[from];
        const end = frame[down].at[to] - frame[down].hi[to];
        // The cards on the two sides can inset further than the stretch is long,
        // when the lines it runs between stand at one place. There is nothing to
        // grab there, and a rect drawn inside out carries a negative length the
        // CSSOM discards, leaving the element the size it last had.
        const run = Math.max(0, end - start);
        out.push(
          axis === 'x'
            ? { key: `x:${line}:${from}`, axis, line, x: along[line] - hit / 2, y: start, w: hit, h: run }
            : { key: `y:${line}:${from}`, axis, line, x: start, y: along[line] - hit / 2, w: run, h: hit },
        );
      }
    }
  }
  return out;
}

/**
 * Where a drop lands: which card, and which part of it.
 *
 * `centre` means the card itself: join the existing card. A side means a new
 * place beside it, and the side is the nearest edge, measured on the body rather
 * than the whole card so a header or status bar is not treated as the top edge.
 *
 * The band is a fraction of the body rather than px, so the target is the same
 * proportion on a small card and a large one.
 */
export type Zone = 'centre' | Side;

export interface ZoneHit {
  id: string;
  zone: Zone;
}

export interface ZoneOptions {
  /** Fixed chrome at the top of a card, excluded from the drop sides. */
  headerPx?: number;
  /** Fixed chrome at the bottom. */
  footerPx?: number;
  /** How much of the body each edge claims, as a fraction. Default 0.25. */
  edge?: number;
  /** A card that always returns `centre`, used when dragging a card onto itself. */
  centreOnly?: string;
}

/** A px measurement from the host, or 0 when it is not one. */
const size = (px: number | undefined): number =>
  Number.isFinite(px) && (px as number) >= 0 ? (px as number) : 0;

export function zoneAt(plane: Plane, x: number, y: number, options: ZoneOptions = {}): ZoneHit | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const frame = frameOf(plane);
  // Every option is checked the same way the plane's are. A chrome height that
  // is not a number makes every comparison below false and every point land on
  // the card rather than a side.
  const header = size(options.headerPx);
  const footer = size(options.footerPx);
  // Every option is checked the same way the plane's are. A fraction that is
  // not one, or one outside the body, makes every point land on a side.
  const asked = options.edge ?? 0.25;
  const edge = Number.isFinite(asked) && asked >= 0 && asked <= 0.5 ? asked : 0.25;

  for (const card of plane.cards) {
    const r = rectIn(frame, card);
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
    if (card.id === options.centreOnly) return { id: card.id, zone: 'centre' };

    const top = r.y + header;
    const bottom = r.y + r.h - footer;
    if (bottom <= top || y < top || y > bottom) return { id: card.id, zone: 'centre' };

    // A card drawn at zero width has no drop zones. Dividing by it gives NaN and
    // every comparison below then falls to the last branch.
    if (!(r.w > 0)) return { id: card.id, zone: 'centre' };
    const px = (x - r.x) / r.w;
    const py = (y - top) / (bottom - top);
    if (px > edge && px < 1 - edge && py > edge && py < 1 - edge) return { id: card.id, zone: 'centre' };

    const nearest = Math.min(px, 1 - px, py, 1 - py);
    const zone: Zone =
      nearest === px ? 'left' : nearest === 1 - px ? 'right' : nearest === py ? 'top' : 'bottom';
    return { id: card.id, zone };
  }
  return null;
}
