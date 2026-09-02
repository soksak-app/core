/**
 * Coordinate computation.
 *
 * `xs` and `ys` hold every position as a fraction of the plane. A card is a
 * span of indices into them, so two cards that meet read the same index.
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
  /** Corridor between two cards, in px. Half of it insets every inner edge. */
  gap: number;
  /** The smallest a card is asked to be, in px. */
  minSize: number;
}

const lines = (plane: Plane, axis: Axis): number[] => (axis === 'x' ? plane.xs : plane.ys);
const extent = (plane: Plane, axis: Axis): number => (axis === 'x' ? plane.width : plane.height);

/** Corridor a slot carries: half a gap on each inner edge. */
export function corridorOf(
  plane: Plane,
  axis: Axis,
  slot: number,
  read = linesRead(plane, axis),
): number {
  return inset(plane, axis, slot, 'lo', read) + inset(plane, axis, slot + 1, 'hi', read);
}

/** The px size each slot declares: the largest any card in it asks for. */
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

/** Drawn width of every slot, corridor removed. */
export function slotWidths(plane: Plane, axis: Axis): number[] {
  const read = linesRead(plane, axis);
  return slotSizes(plane, axis).map((size, i) => size - corridorOf(plane, axis, i, read));
}

/**
 * Width in px of every slot on an axis.
 *
 * A slot held at a px size takes that size; the rest divide what is left in
 * proportion to their spans, down to `minSize` each.
 *
 * When the px sizes do not fit, they are scaled by one factor so the slots
 * still sum to the plane.
 */
export function slotSizes(
  plane: Plane,
  axis: Axis,
  want?: readonly (number | null | undefined)[],
): number[] {
  const a = lines(plane, axis);
  const count = a.length - 1;

  // The slot carries the corridor so a px size is the drawn width.
  const read = linesRead(plane, axis);        // one pass, not one per slot
  const corridor = new Array<number>(count);
  for (let i = 0; i < count; i++) corridor[i] = corridorOf(plane, axis, i, read);

  // What each slot asks for. `want` names a width for a slot, or `null` to make
  // it share; where it names nothing the cards in the slot answer.
  const held = heldSizes(plane, axis);
  if (want) {
    for (let i = 0; i < count; i++) if (want[i] !== undefined) held[i] = want[i] as number | null;
  }

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
  // Plus one card's worth between them. Per slot would overcount a card that
  // spans several.
  if (sharedSpan > 1e-9) floor += plane.minSize;

  const usable = extent(plane, axis) - asked - taken;
  if (sharedSpan > 1e-9 && usable >= floor) {
    const scale = usable / sharedSpan;
    return held.map((fixed, i) =>
      fixed !== null ? fixed + corridor[i] : (a[i + 1] - a[i]) * scale,
    );
  }

  // What was asked for does not fit, or nothing shares at all. The sharing
  // slots keep their floor and the px sizes scale together to cover the rest —
  // one multiple for all of them, so their proportions survive. A sidebar
  // narrows with the window rather than starving the panes or hanging off the
  // edge, and a card that closes always has somewhere to send its room.
  const keep = Math.min(floor, Math.max(0, extent(plane, axis) - taken));
  const left = Math.max(0, extent(plane, axis) - keep - taken);
  const scale = asked > 1e-9 ? left / asked : 0;
  // A sharing slot gets its corridor first, then a share of what is left.
  let floors = 0;
  for (let i = 0; i < count; i++) if (held[i] === null) floors += corridor[i];
  const spare = Math.max(0, keep - floors);
  const each = sharedSpan > 1e-9 ? spare / sharedSpan : 0;
  return held.map((fixed, i) =>
    fixed !== null ? fixed * scale + corridor[i] : corridor[i] + (a[i + 1] - a[i]) * each,
  );
}

/** Every line position in px, index for index with the line array. */
export function linePositions(plane: Plane, axis: Axis): number[] {
  const sizes = slotSizes(plane, axis);
  const out = [0];
  for (const size of sizes) out.push(out[out.length - 1] + size);
  return out;
}

/** How far a card's edge insets from its line: half a corridor, or 0 at a border. */
/**
 * Corridor width for this axis, capped at what the plane can hold.
 *
 * Each real interior line costs one gap. When the total exceeds the plane, the
 * gap is reduced to what the plane holds. A single slot can still be narrower
 * than the corridor it carries; `rectIn` draws that card with no width.
 */
function corridor(plane: Plane, axis: Axis, read = linesRead(plane, axis)): number {
  const a = lines(plane, axis);
  let real = 0;
  for (let k = 1; k < a.length - 1; k++) if (read.has(k)) real++;
  if (real === 0) return plane.gap;
  return Math.min(plane.gap, Math.max(0, extent(plane, axis)) / real);
}

/** Line indices that at least one card references. */
function linesRead(plane: Plane, axis: Axis): Set<number> {
  const [lo, hi] = SPAN[axis];
  const read = new Set<number>();
  for (const card of plane.cards) {
    read.add(card[lo]);
    read.add(card[hi]);
  }
  return read;
}

/**
 * How far a card's edge sits back from the line it reads.
 *
 * `read` is which lines any card references. It costs one pass over the cards,
 * so a caller asking about many lines or many cards works it out once and hands
 * it in; without that a loop over N cards walks the cards N times.
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
  // A line no card references separates nothing and takes no corridor.
  return read.has(index) ? corridor(plane, axis, read) / 2 : 0;
}

/** Half the corridor a real line draws, capped at what the plane can hold. */
export function halfCorridor(plane: Plane, axis: Axis, read = linesRead(plane, axis)): number {
  return corridor(plane, axis, read) / 2;
}

/** Which lines any card references. One pass over the cards. */
export function linesReadOn(plane: Plane, axis: Axis): Set<number> {
  return linesRead(plane, axis);
}

/** Line positions and edge insets for one axis. */
export interface Axle {
  at: number[];
  half: number[];
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
    const gap = corridor(plane, axis, read) / 2;
    const half = a.map((_, i) => (i === 0 || i === a.length - 1 || !read.has(i) ? 0 : gap));
    return { at, half };
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
 * One axis of a rect: where the card starts and how much it holds.
 *
 * A slot narrower than the corridor it carries would put the far edge before
 * the near one. The card has no room there, so it is drawn with none, in the
 * middle of the slots it spans, rather than inside out.
 */
function span(axle: Axle, lo: number, hi: number): [number, number] {
  const near = axle.at[lo] + axle.half[lo];
  const far = axle.at[hi] - axle.half[hi];
  if (far >= near) return [near, far - near];
  return [(axle.at[lo] + axle.at[hi]) / 2, 0];
}

/** The rect of one card. Every rect in the library comes from here. */
export function rectOf(plane: Plane, card: Card): Rect {
  return rectIn(frameOf(plane), card);
}

/** Cards that span across a line. They are why a card cannot be placed on it. */
export function crossing(plane: Plane, axis: Axis, line: number): Card[] {
  const [lo, hi] = SPAN[axis];
  return plane.cards.filter((c) => c[lo] < line && c[hi] > line);
}

/**
 * Index stretches where cards actually break on a line.
 *
 * A line runs the whole plane, but it is only a boundary where one card ends and
 * another begins. Everywhere else a card spans across it, and there is nothing
 * there to grab or to draw solid.
 */
/**
 * Cards indexed by the line they end at and the line they start at.
 *
 * Built once per axis so `boundarySpans` pairs only the cards that meet at a
 * line, rather than every card with every card.
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

export function boundarySpans(
  plane: Plane,
  axis: Axis,
  line: number,
  meet: Touching = touching(plane, axis),
): [number, number][] {
  const [o0, o1] = SPAN[other(axis)];
  const spans: [number, number][] = [];
  for (const before of meet.ends.get(line) ?? []) {
    for (const after of meet.starts.get(line) ?? []) {
      const start = Math.max(before[o0], after[o0]);
      const end = Math.min(before[o1], after[o1]);
      if (end > start) spans.push([start, end]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
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
 * Everything to draw for the boundaries.
 *
 * A line runs the whole plane, so it gets one rule that does; it is only a
 * boundary where cards actually break on it, so each of those stretches gets a
 * solid one. Draw the first faintly and the second not.
 */
export function rules(plane: Plane): Rule[] {
  const out: Rule[] = [];
  const frame = frameOf(plane);
  for (const axis of AXES) {
    // The drawn corridor, not the declared gap: a plane too narrow for the
    // gap draws a smaller one, and a rule drawn to the declared size runs off
    // the plane.
    const half = halfCorridor(plane, axis);
    const along = frame[axis].at;
    const across = axis === 'x' ? plane.height : plane.width;
    const down = other(axis);
    const meet = touching(plane, axis);
    // A rule stays inside the plane. Drawing it half a corridor past each end
    // made the host scroll, since the view places these in the host's element.
    const hold = (v: number): number => Math.min(Math.max(v, 0), across);
    for (const line of interiorLines(plane, axis)) {
      const at = along[line] - 0.5;
      out.push(
        axis === 'x'
          ? { key: `vx:${line}`, axis, line, virtual: true, x: at, y: 0, w: 1, h: across }
          : { key: `vy:${line}`, axis, line, virtual: true, x: 0, y: at, w: across, h: 1 },
      );
      for (const [from, to] of boundarySpans(plane, axis, line, meet)) {
        const start = hold(frame[down].at[from] + frame[down].half[from] - half);
        const end = hold(frame[down].at[to] - frame[down].half[to] + half);
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
 * Where a boundary can be grabbed.
 *
 * Only where cards break on the line — elsewhere a card spans across it and
 * there is nothing between two things to take hold of. The grab area is kept
 * apart from the corridor so a zero gap is still grabbable.
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
        const start = frame[down].at[from] + frame[down].half[from];
        const end = frame[down].at[to] - frame[down].half[to];
        out.push(
          axis === 'x'
            ? { key: `x:${line}:${from}`, axis, line, x: along[line] - hit / 2, y: start, w: hit, h: end - start }
            : { key: `y:${line}:${from}`, axis, line, x: start, y: along[line] - hit / 2, w: end - start, h: hit },
        );
      }
    }
  }
  return out;
}

/**
 * Where a drop lands: which card, and which part of it.
 *
 * `centre` means the card itself — join what is already there. A side means the
 * drop needs a new place beside it, and which side is which edge the point is
 * nearest, measured on the body rather than the whole card, so a header or a
 * status bar cannot read as "the top".
 *
 * The band is a fraction of the body, not px, so a small card and a large one
 * feel the same to aim at.
 */
export type Zone = 'centre' | Side;

export interface ZoneHit {
  id: string;
  zone: Zone;
}

export interface ZoneOptions {
  /** Fixed chrome at the top of a card that is never a drop side. */
  headerPx?: number;
  /** Fixed chrome at the bottom. */
  footerPx?: number;
  /** How much of the body each edge claims, as a fraction. Default 0.25. */
  edge?: number;
  /** A card that only ever answers `centre` — dragging a card onto itself. */
  centreOnly?: string;
}

export function zoneAt(plane: Plane, x: number, y: number, options: ZoneOptions = {}): ZoneHit | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const frame = frameOf(plane);
  const header = options.headerPx ?? 0;
  const footer = options.footerPx ?? 0;
  const edge = options.edge ?? 0.25;

  for (const card of plane.cards) {
    const r = rectIn(frame, card);
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
    if (card.id === options.centreOnly) return { id: card.id, zone: 'centre' };

    const top = r.y + header;
    const bottom = r.y + r.h - footer;
    if (bottom <= top || y < top || y > bottom) return { id: card.id, zone: 'centre' };

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

/** Every axis a card is measured on, for a caller that treats both alike. */
