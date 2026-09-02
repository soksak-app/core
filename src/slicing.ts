/**
 * The property that keeps every card closable.
 *
 * Splitting only ever replaces one card with two, so an arrangement built by
 * splitting is always a *slicing* floorplan — one a single cut can divide in
 * two, recursively. A pinwheel, where four cards each overhang the one in the
 * middle so that no side can take its place, is the canonical arrangement that
 * is not, and splitting cannot reach it.
 *
 * Closing has to preserve that. The moment it does not, cards appear that no
 * neighbour can fill, and there is no way back. So a close asks this module
 * whether the arrangement it would leave behind is still one splitting could
 * have built.
 */

import { SPAN } from './card.js';
import type { Axis, Card } from './card.js';

/** Just the extent of a card. Slicing is a question about regions, not identity. */
export interface Span {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

const key = (list: readonly Span[]): string =>
  list
    .map((r) => `${r.c0},${r.c1},${r.r0},${r.r1}`)
    .sort()
    .join('|');

/**
 * Whether one cut can divide the regions in two, all the way down.
 *
 * Memoised because a close asks it once per candidate side, and the same
 * arrangement comes back constantly during a drag.
 */
export function isSlicing(list: readonly Span[], memo = new Map<string, boolean>()): boolean {
  const k = key(list);
  const hit = memo.get(k);
  if (hit !== undefined) return hit;

  let answer = list.length <= 1;
  if (!answer) {
    outer: for (const axis of ['x', 'y'] as Axis[]) {
      const [lo, hi] = SPAN[axis];
      for (const at of new Set(list.map((r) => r[hi]))) {
        const before = list.filter((r) => r[hi] <= at);
        const after = list.filter((r) => r[lo] >= at);
        if (!before.length || !after.length) continue;
        if (before.length + after.length !== list.length) continue;
        if (isSlicing(before, memo) && isSlicing(after, memo)) {
          answer = true;
          break outer;
        }
      }
    }
  }

  if (memo.size > 4000) memo.clear();
  memo.set(k, answer);
  return answer;
}

/** Which cards would take over a closed card's space, and from which side. */
export interface Fill {
  side: 'below' | 'above' | 'right' | 'left';
  /** The span key each of them grows by. */
  grow: 'r0' | 'r1' | 'c0' | 'c1';
  cards: Card[];
}

/** Which axis a close tries first when giving the space back. */
export type FillOrder = 'v' | 'h';

interface Direction {
  side: Fill['side'];
  grow: Fill['grow'];
  touches: (card: Card, closing: Card) => boolean;
  /** The span keys the row of fillers has to tile along. */
  lo: 'c0' | 'r0';
  hi: 'c1' | 'r1';
}

const DIRECTIONS: Record<Fill['side'], Direction> = {
  below: { side: 'below', grow: 'r0', touches: (c, x) => c.r0 === x.r1, lo: 'c0', hi: 'c1' },
  above: { side: 'above', grow: 'r1', touches: (c, x) => c.r1 === x.r0, lo: 'c0', hi: 'c1' },
  right: { side: 'right', grow: 'c0', touches: (c, x) => c.c0 === x.c1, lo: 'r0', hi: 'r1' },
  left: { side: 'left', grow: 'c1', touches: (c, x) => c.c1 === x.c0, lo: 'r0', hi: 'r1' },
};

const ORDER: Record<FillOrder, readonly Fill['side'][]> = {
  v: ['below', 'above', 'right', 'left'],
  h: ['right', 'left', 'below', 'above'],
};

/**
 * Which neighbours take a closed card's space.
 *
 * One neighbour need not match it exactly — a row of them may tile the side
 * together — but what is left has to be slicing again, which is what keeps every
 * card closable afterwards. In a slicing arrangement such a side always exists.
 *
 * A fixed card never fills: its size is its own, so growing it would answer a
 * question nobody asked, and one at the plane's edge would spread over it.
 *
 * A card holding a px size does fill. Growing across a second slot means it
 * stops holding a size, and that is the right answer: the number described one
 * slot and the card no longer stands in one. Refusing instead left cards that
 * nothing could close.
 */
export function fillFor(
  cards: readonly Card[],
  closing: Card,
  order: FillOrder,
  memo?: Map<string, boolean>,
): Fill | null {
  if (closing.fixed) return null;
  if (cards.filter((c) => !c.fixed).length <= 1) return null;

  for (const side of ORDER[order]) {
    const dir = DIRECTIONS[side];
    const row = cards
      .filter(
        (c) =>
          c !== closing &&
          !c.fixed &&
          dir.touches(c, closing) &&
          c[dir.lo] >= closing[dir.lo] &&
          c[dir.hi] <= closing[dir.hi],
      )
      .sort((a, b) => a[dir.lo] - b[dir.lo]);
    if (!row.length) continue;

    let at = closing[dir.lo];
    let tiles = true;
    for (const card of row) {
      if (card[dir.lo] !== at) {
        tiles = false;
        break;
      }
      at = card[dir.hi];
    }
    if (!tiles || at !== closing[dir.hi]) continue;

    const after: Span[] = cards
      .filter((c) => c !== closing)
      .map((c) => {
        const span: Span = { c0: c.c0, c1: c.c1, r0: c.r0, r1: c.r1 };
        if (row.includes(c)) span[dir.grow] = closing[dir.grow];
        return span;
      });
    if (isSlicing(after, memo)) return { side, grow: dir.grow, cards: row };
  }
  return null;
}
