/**
 * The stored form of a grid: its canonical slicing tree
 * (packages/soksak/docs/layout.md#the-model).
 *
 * A card node is a leaf, a box node is a rectangle of the host around one inner
 * node, and a cut node divides its rectangle along an axis into kids, each with
 * the share of the extent of the cut that it takes. The lines and the cells are
 * derived from the tree after every change and never read back, so two cuts
 * whose lines meet by chance stay two cuts.
 */
import type { Axis } from './card.js';
/** A card of the tree. `width` and `height` are px sizes, as on a card of the cells. */
export interface CardNode {
    card: string;
    data?: unknown;
    fixed?: boolean;
    width?: number;
    height?: number;
}
/** A rectangle of the host around its inner node, such as a group card, with the data of the host. */
export interface BoxNode {
    box: string;
    data?: unknown;
    inner: TreeNode;
}
/** A kid of a cut: its node and the share of the extent of the cut that it takes. */
export interface Kid {
    share: number;
    node: TreeNode;
}
/** A cut along `cut` into its kids in their order. */
export interface CutNode {
    cut: Axis;
    kids: Kid[];
}
export type TreeNode = CardNode | BoxNode | CutNode;
export interface SoksakState {
    root: TreeNode;
}
/** The distance under which two coordinates are one line (R1), and the tolerance of the sum of the shares. */
export declare const EPS = 1e-9;
export declare const isCut: (node: TreeNode) => node is CutNode;
export declare const isBox: (node: TreeNode) => node is BoxNode;
export declare const isCard: (node: TreeNode) => node is CardNode;
/** The id of a card or a box, and null for a cut. */
export declare const idOf: (node: TreeNode) => string | null;
/**
 * Rejects a state that is not a canonical slicing tree and names what is wrong;
 * nothing is converted. A state of the earlier form, which held the lines and
 * the cells, is refused with that name.
 */
export declare function checkState(state: SoksakState): void;
/** A deep copy of a node. The data of the host is copied by reference, as the layout does not read it. */
export declare function cloneNode(node: TreeNode): TreeNode;
/** The card nodes of a node in the order of the tree. */
export declare function cardsOf(node: TreeNode, out?: CardNode[]): CardNode[];
