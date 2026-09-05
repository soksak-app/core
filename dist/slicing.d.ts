/**
 * Slicing check and fill selection.
 *
 * Splitting replaces one card with two, so an arrangement built by splitting is
 * always a slicing floorplan: one a single cut can divide in two, recursively.
 * A close must leave it slicing, or cards appear that no neighbour can fill.
 *
 * `isSlicing` reports whether an arrangement is slicing. `fillFor` selects the
 * row of neighbours that expands over a closing card.
 */
import type { Card } from './card.js';
/** A card's extent only. The slicing check reads regions, not identities. */
export interface Span {
    c0: number;
    c1: number;
    r0: number;
    r1: number;
}
/**
 * Whether one cut can divide the regions in two, all the way down.
 *
 * Memoised because a close calls it once per candidate side and the same
 * arrangement recurs during a drag.
 */
export declare function isSlicing(list: readonly Span[], memo?: Map<string, boolean>): boolean;
/** The cards that take a closed card's space, and the side they come from. */
export interface Fill {
    side: 'below' | 'above' | 'right' | 'left';
    /** The span key each of them expands by. */
    grow: 'r0' | 'r1' | 'c0' | 'c1';
    cards: Card[];
}
/** The axis a close tries first when redistributing the space. */
export type FillOrder = 'v' | 'h';
/**
 * Returns the neighbours that take a closed card's space.
 *
 * A row of neighbours may tile the side together. The result must remain
 * slicing, which keeps every card closable.
 *
 * A `fixed` card never fills, because the layout may not expand it. A card with
 * a px size does fill, and spanning a second slot removes that size.
 */
export declare function fillFor(cards: readonly Card[], closing: Card, order: FillOrder, memo?: Map<string, boolean>): Fill | null;
