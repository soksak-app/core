/**
 * Fair sizes for an arrangement that is kept.
 *
 * An arrangement built by splitting is a slicing floorplan, so it reads as a
 * slicing tree. A card counts one along each axis; a cut along an axis counts
 * the sum of its sides, and a cut along the other axis counts the side that
 * holds the most. Each cut gives its sides space in proportion to that count,
 * so every card in the row that holds the most cards is drawn at the same size
 * and a card that spans several of them is drawn across them.
 *
 * A card with a px size on an axis keeps the size it is drawn at and counts
 * nothing there; the others share what is left.
 */
import type { Axis, Card } from './card.js';
/** A card, or a cut along `axis` into sides ordered from the plane's start. */
export type Slice = {
    card: Card;
} | {
    axis: Axis;
    sides: Slice[];
};
/**
 * The slicing tree of an arrangement, or null when it is not slicing.
 *
 * Every line one cut can divide the cards at is taken at once, so the sides of
 * a cut along an axis are the cards between two of those lines.
 */
export declare function sliceTree(cards: readonly Card[]): Slice | null;
/** How many fair shares a slice takes along an axis. */
export declare function weight(slice: Slice, axis: Axis): number;
/** A region of the plane in px, from line to line, and which of its edges are the plane's. */
export interface Region {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    /** True where the edge is the plane's border, which has no corridor. */
    left: boolean;
    right: boolean;
    top: boolean;
    bottom: boolean;
}
/**
 * The region of every card once the slice is balanced inside `region`.
 *
 * `drawn` is the size a card with a px size is drawn at on an axis; `gap` is the
 * corridor between two neighbours, which each of them gives half of.
 */
export declare function balanceRegions(slice: Slice, region: Region, gap: number, drawn: (card: Card, axis: Axis) => number, out?: Map<string, Region>): Map<string, Region>;
