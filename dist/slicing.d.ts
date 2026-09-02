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
import type { Card } from './card.js';
/** Just the extent of a card. Slicing is a question about regions, not identity. */
export interface Span {
    c0: number;
    c1: number;
    r0: number;
    r1: number;
}
/**
 * Whether one cut can divide the regions in two, all the way down.
 *
 * Memoised because a close asks it once per candidate side, and the same
 * arrangement comes back constantly during a drag.
 */
export declare function isSlicing(list: readonly Span[], memo?: Map<string, boolean>): boolean;
/** Which cards would take over a closed card's space, and from which side. */
export interface Fill {
    side: 'below' | 'above' | 'right' | 'left';
    /** The span key each of them grows by. */
    grow: 'r0' | 'r1' | 'c0' | 'c1';
    cards: Card[];
}
/** Which axis a close tries first when giving the space back. */
export type FillOrder = 'v' | 'h';
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
export declare function fillFor(cards: readonly Card[], closing: Card, order: FillOrder, memo?: Map<string, boolean>): Fill | null;
