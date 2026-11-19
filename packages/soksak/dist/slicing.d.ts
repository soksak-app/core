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
export declare const DIRECTIONS: Record<Fill['side'], Direction>;
export declare const ORDER: Record<FillOrder, readonly Fill['side'][]>;
