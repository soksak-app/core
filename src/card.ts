/**
 * A card, and what a role means.
 *
 * Everything on the plane is a card — a sidebar, a rail, a terminal. One type,
 * one rect rule, one corridor, one radius, one outline. A role is one answer:
 * whether the layout moves it — split, close and move, or never. A card may
 * also carry a `width`, which is an attribute and not a second kind of card.
 *
 * That is what makes a sidebar and a terminal the same object. A sidebar at the
 * window's edge is a card holding the first column; the same card holding a
 * middle column is a rail standing between panes. There is no second kind of
 * thing to keep in step, and no line to check — a card occupies its columns, so
 * nothing can cross it.
 */

export type Axis = 'x' | 'y';

/** Which side of a card something goes on. `left` and `top` land ahead of it. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardInit {
  id: string;
  /** Column span over `xs`. `c0 < c1`. */
  c0: number;
  c1: number;
  /** Row span over `ys`. `r0 < r1`. */
  r0: number;
  r1: number;
  /**
   * Takes this many px across instead of a share of what is left.
   *
   * Only a card holding a single column can fix its width — one spanning several
   * is taking a share of them, and there would be no one slot to fix.
   */
  width?: number;
  /** Takes this many px down instead of a share of what is left. */
  height?: number;
  /** A card the layout never splits, closes, moves, or grows into a gap. */
  fixed?: boolean;
  /** Anything the host wants to carry along. Never read by this library. */
  data?: unknown;
}

export interface Card extends CardInit {
  fixed: boolean;
}

/** The pair of span keys an axis is measured by. */
export const SPAN: Record<Axis, readonly ['c0' | 'r0', 'c1' | 'r1']> = {
  x: ['c0', 'c1'],
  y: ['r0', 'r1'],
};

/** The pair for the other axis — a card's extent across the one being measured. */
export const CROSS: Record<Axis, readonly ['c0' | 'r0', 'c1' | 'r1']> = {
  x: ['r0', 'r1'],
  y: ['c0', 'c1'],
};

export const AXES: readonly Axis[] = ['x', 'y'];

export const axisOf = (side: Side): Axis =>
  side === 'left' || side === 'right' ? 'x' : 'y';

/** Whether a side lands ahead of the card it names. */
export const isAhead = (side: Side): boolean => side === 'left' || side === 'top';

/** How many slots a card spans along an axis. One means it can hold that slot. */
export const spanOf = (card: Card, axis: Axis): number => {
  const [lo, hi] = SPAN[axis];
  return card[hi] - card[lo];
};

/** The fixed size a card declares along an axis, or null when it takes a share. */
export function fixedSize(card: Card, axis: Axis): number | null {
  if (spanOf(card, axis) !== 1) return null;
  const size = axis === 'x' ? card.width : card.height;
  return typeof size === 'number' && Number.isFinite(size) ? Math.max(0, size) : null;
}
