/**
 * The fill of a close: the side whose neighbour takes the space of a closing
 * card, the span key it grows by, and the order of the sides.
 */

import type { Card } from './card.js';

/** The cards that take a closed card's space, and the side they come from. */
export interface Fill {
  side: 'below' | 'above' | 'right' | 'left';
  /** The span key each of them expands by. */
  grow: 'r0' | 'r1' | 'c0' | 'c1';
  cards: Card[];
}

/** The axis a close tries first when redistributing the space. */
export type FillOrder = 'v' | 'h';

export interface Direction {
  side: Fill['side'];
  grow: Fill['grow'];
  touches: (card: Card, closing: Card) => boolean;
}

export const DIRECTIONS: Record<Fill['side'], Direction> = {
  below: { side: 'below', grow: 'r0', touches: (c, x) => c.r0 === x.r1 },
  above: { side: 'above', grow: 'r1', touches: (c, x) => c.r1 === x.r0 },
  right: { side: 'right', grow: 'c0', touches: (c, x) => c.c0 === x.c1 },
  left: { side: 'left', grow: 'c1', touches: (c, x) => c.c1 === x.c0 },
};

export const ORDER: Record<FillOrder, readonly Fill['side'][]> = {
  v: ['below', 'above', 'right', 'left'],
  h: ['right', 'left', 'below', 'above'],
};
