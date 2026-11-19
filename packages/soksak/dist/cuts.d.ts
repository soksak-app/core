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
import type { TreeNode } from './tree.js';
/** The drawn rectangle of each card by id. */
export type Drawn = ReadonlyMap<string, Rect>;
/** The px of the drawn size per unit of span on an axis. */
export type Rate = (axis: Axis) => number;
/** A rectangle in the coordinates of the lines, 0..1 over the sharing slots of each axis. */
export interface Extent {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}
/** What an operation of the cuts reads of the grid: the stored tree, where each node stands, the cards, their drawing and the heads. */
export interface Input {
    root: TreeNode;
    extent(node: TreeNode): Extent;
    card(id: string): Card;
    /** Whether an id names a card or a box of the tree. */
    taken(id: string): boolean;
    drawn: Drawn;
    heads: ReadonlyMap<string, number>;
    /** Counts each node that an operation visits (packages/soksak/docs/layout.md#cuts). */
    visit(): void;
}
/** An operation laid out: `layout` gives the stored tree, and `correct` reads its drawing and returns the largest error in px. */
export interface Plan {
    layout(): TreeNode;
    correct(drawn: Drawn, rate: Rate): number;
    /** The text of the outermost changed node drawn below its minimum, or null. */
    minimum(drawn: Drawn, min: number): string | null;
}
/** ADD: the plan of adding `node`, a new card or what `withdraw` returned, beside `target` toward `side`. */
export declare function insertNode(input: Input, target: string | readonly string[], side: Side, node: TreeNode, gap: number): Plan;
/** REMOVE: the plan of taking the card or the box `id` out of its cut, and the stored node that left. */
export declare function withdrawNode(input: Input, id: string, cards: readonly Card[]): {
    plan: Plan;
    left: TreeNode;
};
/** Even: the plan of giving every kid of every cut an equal share. */
export declare function evenCuts(input: Input): Plan;
