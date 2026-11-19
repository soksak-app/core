/**
 * The two primitives of the rule of sizes over the slicing tree, and even shares
 * (packages/soksak/docs/layout.md#cuts).
 *
 * A cut divides a rectangle along one axis into children: cards, boxes of the
 * host and cuts along the other axis. REMOVE (`withdraw`) takes a member out of
 * its cut, and the other children take its space in proportion to their sizes.
 * ADD (`insert`) puts a card beside a target: along the cut of the target, an
 * even cut gives the card 1/(k+1) and keeps every ratio, and a cut that is not
 * even takes half of the target for the card and keeps every other size; across
 * it, the target is wrapped in a new cut of two halves. `even` gives every child
 * of every cut an equal share.
 *
 * A size is a drawn size, the extent of the drawn rectangles of a child less on
 * the y axis the heads above it, and the library draws a slot at its span of the
 * whole plane less its corridor, so a size is not a span. An operation returns a
 * plan: `layout` lays the changed cuts by their weights, the grid draws the
 * result, and `correct` moves each laid span by the difference between the size
 * drawn and the size the weights ask for. Only the children of a cut that an
 * operation changes are laid again; every other card keeps its coordinates, and
 * coordinates within a billionth are one line (R1). `minimum` judges the result:
 * a node whose rectangle changed is refused below its minimum, computed
 * recursively with heads and corridors as fixed costs.
 */
import type { Axis, Card, Rect, Side } from './card.js';
/** A rectangle of the host that the tree keeps as one child, with the px of its head above its members. */
export interface Box {
    id: string;
    head: number;
    members: Member[];
}
/** A member of the plane or of a box: a card id or a box. */
export type Member = string | Box;
/** A card that left with `withdraw`, without its spans, at the coordinates it had and with the rectangle it was drawn at. */
export interface LeftCard {
    card: Omit<Card, 'c0' | 'c1' | 'r0' | 'r1'>;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    rect: Rect;
}
/** The drawn rectangle of each card by id. */
export type Drawn = ReadonlyMap<string, Rect>;
/** The px of the drawn size per unit of span on an axis. */
export type Rate = (axis: Axis) => number;
/** An operation laid out: `layout` gives the cells, and `correct` reads their drawing and returns the largest error in px. */
export interface Plan {
    layout(): Cells;
    correct(drawn: Drawn, rate: Rate): number;
    /** The text of the outermost changed node drawn below its minimum, or null. */
    minimum(drawn: Drawn, min: number): string | null;
}
/** What `withdraw` took out of the plane: a card or a box with the cards inside it, and the px of heads that stood above it. */
export interface Withdrawn {
    id: string;
    box: Box | null;
    above: number;
    cards: LeftCard[];
}
/** A card that `insert` adds: a new card, or what `withdraw` returned. */
export type Arriving = {
    id: string;
    data?: unknown;
} | Withdrawn;
/** The state the functions read and write: the lines and the cards. */
export interface Cells {
    xs: number[];
    ys: number[];
    cards: Card[];
}
/** ADD: the plan of adding `card` beside `target` toward `side`. */
export declare function insertCard(cells: Cells, boxes: readonly Box[], drawn: Drawn, target: string | readonly string[], side: Side, card: Arriving, gap: number): Plan;
/** REMOVE: the plan of taking the member `id` out of its cut, and what left. `prefer` is the outer cut first. */
export declare function withdrawMember(cells: Cells, boxes: readonly Box[], drawn: Drawn, id: string, prefer: readonly Axis[]): {
    plan: Plan;
    left: Withdrawn;
};
/** Even: the plan of giving every child of every cut an equal share. */
export declare function evenCuts(cells: Cells, boxes: readonly Box[], drawn: Drawn): Plan;
