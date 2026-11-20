/**
 * The two primitives of the rule of sizes over the slicing tree, and even shares
 * (packages/soksak/docs/layout.md#cuts).
 *
 * A cut divides a rectangle along one axis into children: cards, boxes of the
 * host and cuts along the other axis. Every rule works on the fractions of the
 * stored tree; the grid draws a kid at its fraction of what its cut has left once
 * the corridors, the px sizes, the frames and the heads are laid, so equal
 * fractions draw equal sizes. REMOVE (`withdraw`) takes a member out of its cut,
 * and the other kids that keep no size of their own take its fraction by one
 * factor. ADD (`insert`) puts a node beside a target: along the cut of the
 * target, an even cut gives the node 1/(k+1) and keeps every ratio, and a cut
 * that is not even gives the node half of the fraction of the target; across it,
 * the target is wrapped in a new cut of two halves. `even` gives the kids of
 * every cut equal fractions. An operation returns the stored tree it makes; the
 * grid lays it and refuses a result that draws a changed node below its minimum.
 */
import type { Axis, Side } from './card.js';
import type { CardNode, TreeNode } from './tree.js';
/** What an operation of the cuts reads of the grid. */
export interface Input {
    /** A copy of the stored tree, which the operation changes. */
    root: TreeNode;
    /** Whether an id names a card or a box of the grid. */
    taken(id: string): boolean;
    /**
     * Whether a node keeps its size on an axis whatever its fraction: a fixed card,
     * or a node drawn at a px size there.
     */
    keeps(node: TreeNode, axis: Axis): boolean;
    /** The px size of a node on an axis as the grid draws it now, its corridors and frames left out; a new node has none. */
    content(node: TreeNode, axis: Axis): number;
    /** The corridor of an axis in px. */
    corridor(axis: Axis): number;
    /** Counts each node that an operation visits (packages/soksak/docs/layout.md#cuts). */
    visit(): void;
}
/** ADD: the stored tree with `node`, a new card or what `withdraw` returned, beside `target` toward `side`. */
export declare function insertNode(input: Input, target: string | readonly string[], side: Side, node: TreeNode): TreeNode;
/** ADD beside a node of the stored tree of `input`: the stored tree with `node` beside `target` toward `side`. */
export declare function insertBeside(input: Input, target: TreeNode, side: Side, node: TreeNode): TreeNode;
/**
 * The group split (packages/soksak/docs/layout.md#add-and-remove): the stored tree with the box `box` and its `data` in the place of
 * `target`, with its fraction, around a cut of two halves along the axis of `side` that holds `target` and `node` toward `side`.
 */
export declare function groupNode(input: Input, target: string, side: Side, node: TreeNode, box: string, data: unknown): TreeNode;
/**
 * The inverse of the group split: the stored tree with the inner node of the box `id` in its place; a cut along the axis of the cut
 * that holds the box joins that cut with every kid drawn at the size it had.
 */
export declare function unwrapNode(input: Input, id: string): TreeNode;
/** REMOVE: the stored tree without the card or the box `id`, and the stored node that left. */
export declare function withdrawNode(input: Input, id: string, cards: readonly {
    id: string;
    fixed: boolean;
}[]): {
    root: TreeNode;
    left: TreeNode;
};
/** Even: the stored tree with equal fractions for the kids of every cut that take one. */
export declare function evenCuts(input: Input): TreeNode;
export type { CardNode };
