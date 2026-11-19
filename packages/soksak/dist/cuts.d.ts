/**
 * Even shares over the cuts of the slicing tree (packages/soksak/docs/layout.md#cuts).
 *
 * A cut divides a rectangle along one axis into children: cards, boxes of the
 * host and cuts along the other axis. `even` gives every child of every cut an
 * equal size. A size is a drawn size, the extent of the drawn rectangles of a
 * child less on the y axis the heads above it, and the grid draws a slot at its
 * span of the whole plane less its corridor, so a size is not a span: a plan
 * lays every cut by equal spans, the grid draws the result, and `correct` moves
 * each span by the difference between the size drawn and the equal size. A
 * corridor does not change with the span, so one correction lays the sizes
 * exactly; a nested cut takes one more. Coordinates within a billionth are one
 * line (R1).
 */
import type { Axis, Card, Rect } from './card.js';
/** A rectangle of the host that the tree keeps as one child, with the px of its head above its members. */
export interface Box {
    id: string;
    head: number;
    members: Member[];
}
/** A member of the plane or of a box: a card id or a box. */
export type Member = string | Box;
/** The drawn rectangle of each card by id. */
export type Drawn = ReadonlyMap<string, Rect>;
/** The px of the drawn size per unit of span on an axis. */
export type Rate = (axis: Axis) => number;
/** An operation laid out: `layout` gives the cells, and `correct` reads their drawing and returns the largest error in px. */
export interface Plan {
    layout(): Cells;
    correct(drawn: Drawn, rate: Rate): number;
}
/** The state the plan reads and writes: the lines and the cards. */
export interface Cells {
    xs: number[];
    ys: number[];
    cards: Card[];
}
/**
 * The plan that gives every child of every cut an equal size. The cards that no box holds and the boxes are the members of the plane;
 * the members of a box have a tree of their own inside its rectangle, so no cut crosses a box.
 */
export declare function evenCuts(cells: Cells, boxes: readonly Box[]): Plan;
