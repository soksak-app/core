/**
 * Slicing check and fill selection.
 *
 * Splitting replaces one card with two, so an arrangement built by splitting is
 * always a slicing floorplan: one a single cut can divide in two, recursively.
 * A close must leave it slicing, or cards appear that no neighbour can fill.
 *
 * `isSlicing` answers that. `fillFor` picks the row of neighbours that grows
 * over a closing card.
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
 * A row of neighbours may tile the side together. The result must still be
 * slicing, which keeps every card closable.
 *
 * A `fixed` card never fills, since the layout may not grow it. A card with a
 * px size does fill; spanning a second slot drops that size.
 */
export declare function fillFor(cards: readonly Card[], closing: Card, order: FillOrder, memo?: Map<string, boolean>): Fill | null;
