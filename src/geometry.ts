/**
 * The only place coordinates are computed.
 *
 * Two arrays of numbers own every position. A card is a span of indices into
 * them, so two cards that meet read the same index and their shared boundary is
 * one number — it cannot drift, and there is no tolerance anywhere that decides
 * whether two places are the same place.
 *
 * Every function here is pure. The arrangement holds the state and asks.
 */

import { AXES, CROSS, SPAN, fixedSize } from './card.js';
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

/**
 * The px width of every slot along an axis.
 *
 * The plane is covered exactly, always. A slot a card holds at a px size takes
 * that size and the rest share what is left — the whole story while there is
 * something left to share.
 *
 * When there is not — every slot held, or the plane narrower than what was
 * asked for — the px sizes scale together to cover it. A card that closes has
 * to send its room somewhere, and a sidebar narrowing with the window is the
 * same fact from the other side: a px size is what a card gets when the plane
 * can give it, not a claim on room the plane does not have.
 */
export function slotSizes(plane: Plane, axis: Axis): number[] {
  const a = lines(plane, axis);
  const [lo] = SPAN[axis];
  const count = a.length - 1;

  // A px size is what the card is drawn at, so the slot carries the corridor
  // and the card never pays for it — otherwise the same 180 would draw 174 at
  // the plane's edge and 168 between two cards.
  const corridor = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    corridor[i] = inset(plane, axis, i, 'lo') + inset(plane, axis, i + 1, 'hi');
  }

  const held = new Array<number | null>(count).fill(null);
  for (const card of plane.cards) {
    const size = fixedSize(card, axis);
    if (size === null) continue;
    const slot = card[lo];
    held[slot] = Math.max(held[slot] ?? 0, size);
  }

  let asked = 0;      // px the held slots were told to be
  let taken = 0;      // corridor those slots carry on top
  let sharedSpan = 0; // how the rest divide what is left
  let floor = 0;      // the corridor the rest carry, whatever else they get
  for (let i = 0; i < count; i++) {
    if (held[i] !== null) {
      asked += held[i] as number;
      taken += corridor[i];
    } else {
      sharedSpan += a[i + 1] - a[i];
      floor += corridor[i];
    }
  }
  // and between them one card's worth of room, so panes are not starved to
  // nothing while a sidebar keeps its number. Per slot would count a card that
  // spans several of them once for each.
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
  const each = sharedSpan > 1e-9 ? keep / sharedSpan : 0;
  return held.map((fixed, i) =>
    fixed !== null ? fixed * scale + corridor[i] : (a[i + 1] - a[i]) * each,
  );
}

/** Where a grid line falls in px — the sum of every slot before it. */
export function linePos(plane: Plane, axis: Axis, index: number): number {
  const sizes = slotSizes(plane, axis);
  let at = 0;
  for (let i = 0; i < index; i++) at += sizes[i];
  return at;
}

/** Every line position in px, index for index with the line array. */
export function linePositions(plane: Plane, axis: Axis): number[] {
  const sizes = slotSizes(plane, axis);
  const out = [0];
  for (const size of sizes) out.push(out[out.length - 1] + size);
  return out;
}

/**
 * How far a card's edge pulls back from the line it sits on.
 *
 * Half a corridor on every side that faces another card, and nothing at the
 * plane's own border. One rule, so no card needs a special case.
 */
export function inset(plane: Plane, axis: Axis, index: number, side: 'lo' | 'hi'): number {
  const a = lines(plane, axis);
  const flush = side === 'lo' ? index === 0 : index === a.length - 1;
  return flush ? 0 : plane.gap / 2;
}

/** Where a card's edge falls in px. */
export function edgePos(plane: Plane, axis: Axis, index: number, side: 'lo' | 'hi'): number {
  const at = linePos(plane, axis, index);
  const back = inset(plane, axis, index, side);
  return side === 'lo' ? at + back : at - back;
}

/** The rect of one card. Every rect in the library comes from here. */
export function rectOf(plane: Plane, card: Card): Rect {
  const x0 = edgePos(plane, 'x', card.c0, 'lo');
  const x1 = edgePos(plane, 'x', card.c1, 'hi');
  const y0 = edgePos(plane, 'y', card.r0, 'lo');
  const y1 = edgePos(plane, 'y', card.r1, 'hi');
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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
export function boundarySpans(plane: Plane, axis: Axis, line: number): [number, number][] {
  const [lo, hi] = SPAN[axis];
  const [o0, o1] = CROSS[axis];
  const spans: [number, number][] = [];
  for (const before of plane.cards) {
    if (before[hi] !== line) continue;
    for (const after of plane.cards) {
      if (after[lo] !== line) continue;
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

/** Whether any card reads this line at all. One that none reads is only a memory of a boundary. */
export function isVirtual(plane: Plane, axis: Axis, line: number): boolean {
  const [lo, hi] = SPAN[axis];
  return !plane.cards.some((c) => c[lo] === line || c[hi] === line);
}

/** The interior lines of an axis — the plane's own two borders are not boundaries. */
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

/** A place to grab a boundary. */
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
  const half = plane.gap / 2;
  for (const axis of AXES) {
    const along = linePositions(plane, axis);
    const across = axis === 'x' ? plane.height : plane.width;
    const other: Axis = axis === 'x' ? 'y' : 'x';
    for (const line of interiorLines(plane, axis)) {
      const at = along[line] - 0.5;
      out.push(
        axis === 'x'
          ? { key: `vx:${line}`, axis, line, virtual: true, x: at, y: -half, w: 1, h: across + plane.gap }
          : { key: `vy:${line}`, axis, line, virtual: true, x: -half, y: at, w: across + plane.gap, h: 1 },
      );
      for (const [from, to] of boundarySpans(plane, axis, line)) {
        const start = edgePos(plane, other, from, 'lo') - half;
        const end = edgePos(plane, other, to, 'hi') + half;
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
  for (const axis of AXES) {
    const along = linePositions(plane, axis);
    const other: Axis = axis === 'x' ? 'y' : 'x';
    for (const line of interiorLines(plane, axis)) {
      for (const [from, to] of boundarySpans(plane, axis, line)) {
        const start = edgePos(plane, other, from, 'lo');
        const end = edgePos(plane, other, to, 'hi');
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
  const header = options.headerPx ?? 0;
  const footer = options.footerPx ?? 0;
  const edge = options.edge ?? 0.25;

  for (const card of plane.cards) {
    const r = rectOf(plane, card);
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
