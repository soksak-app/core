/**
 * A soksak over a slicing tree.
 *
 * The state is the canonical slicing tree of the plane (`tree.ts`,
 * packages/soksak/docs/layout.md#the-model). After every change the grid
 * derives from it `xs` and `ys`, every coordinate at which the rectangle of a
 * node starts or ends, normalised 0..1 over the slots that share the remaining
 * space, and each card as a span of indices into them. A slot with a px size is
 * drawn at that size whatever its span, so a line's px position is not its value
 * times the plane size. Two cards that meet reference the same index, so their
 * shared boundary is one value.
 *
 * The operations of the structure (split, close, insert, move, arrange and the
 * cut operations) change the tree. The operations of a line (a boundary drag and
 * the settle of a slot to a px width) move the derived lines, and `commit`
 * writes the shares that the moved lines give back into the cuts of the tree,
 * whose structure stays. `geometry.ts` computes the coordinates.
 */
import type { Axis, Card, Rect, Side } from './card.js';
import type { Divider, Rule, ZoneHit, ZoneOptions } from './geometry.js';
export type { Divider, Rule, Zone, ZoneHit, ZoneOptions } from './geometry.js';
import type { SoksakState, TreeNode } from './tree.js';
export type { Axis, Card, CardInit, Rect, Side } from './card.js';
export type { BoxNode, CardNode, CutNode, Kid, SoksakState, TreeNode } from './tree.js';
export { checkState } from './tree.js';
/** `merge`: a dragged boundary snaps onto a neighbouring line and the two combine. */
export type SnapMode = 'merge' | 'off';
/**
 * What the frame of a box takes on its left, right and bottom side: `corridor` one corridor, so a box stands one corridor around
 * its inner node; `none` nothing, so a box is drawn at the rectangle of its inner node and the corridor between two boxes is one
 * corridor, as at a seam where the corridor is the one border line that two boxes share.
 */
export type FrameMode = 'corridor' | 'none';
export interface SoksakOptions {
    /** Gap between two cards, in px. Half of it insets every inner edge. Default 24. */
    gap?: number;
    /** Smallest card edge, in px. Splitting, dragging and resizing all respect it. Default 96. */
    minSize?: number;
    /** Smallest hit area, in px. Independent of `gap` so a zero gap is still draggable. Default 11. */
    grabSize?: number;
    /** How close a dragged boundary must come to a neighbour to snap onto it, in px. Default 7. */
    snapDistance?: number;
    /** How a dragged boundary snaps. Default `merge`. */
    snap?: SnapMode;
    /** What the frame of a box takes on each side but its top. Default `corridor`. */
    frames?: FrameMode;
    /** Plane width in px. Default 0 until `resize`. */
    width?: number;
    /** Plane height in px. Default 0 until `resize`. */
    height?: number;
}
export declare class Soksak {
    /** The state: the slicing tree of the plane. */
    private root;
    private xs;
    private ys;
    private list;
    private byId;
    private leaves;
    private boxes;
    private at;
    private spots;
    /** The px that each node stands inside its slot: the corridors and frames on each side, and on top the heads above it. */
    private insets;
    /** The corridor of each axis in px, which the last derive laid. */
    private unit;
    /** The px position of each line per axis from the last layout of the tree, or null on a plane with no size. */
    private linesAt;
    /** The px of the heads of the boxes that start on the top line of each card. */
    private above;
    /** Whether an operation moved the lines, so the commit reads the fractions from them. */
    private moved;
    private up;
    /** The px that the host draws inside the top of each box by id, which `setHeads` set. */
    private heads;
    /** The nodes that the last operation visited, and how deep the public operations that run now are nested. */
    private visited;
    private depth;
    private w;
    private h;
    private seq;
    private splitMemo;
    /** True while canSplit runs a trial split and restores the state. */
    private probing;
    private g;
    /** Gap between two cards, in px. Clamped to 0; a negative value overlaps cards. */
    get gap(): number;
    set gap(px: number);
    private min;
    /** Minimum drawn size of a card on either axis. */
    get minSize(): number;
    /** Assigning it clears the values cached against the previous one. */
    set minSize(px: number);
    private grab;
    /** Smallest grab area of a boundary, in px. */
    get grabSize(): number;
    set grabSize(px: number);
    private snapAt;
    /** How near a dragged boundary must come to a neighbour to land on it, in px. */
    get snapDistance(): number;
    set snapDistance(px: number);
    private snapMode;
    private frameAt;
    /** What the frame of a box takes on its left, right and bottom side (R5). */
    get frames(): FrameMode;
    /** Assigning it keeps every fraction and lays the tree with the new frames. */
    set frames(mode: FrameMode);
    /** Whether a dragged boundary lands on a neighbour it nearly meets. */
    get snap(): SnapMode;
    set snap(mode: SnapMode);
    constructor(state?: SoksakState, options?: SoksakOptions);
    static from(state: SoksakState, options?: SoksakOptions): Soksak;
    /** Takes the tree of a state as a copy and derives the lines and the cells. */
    private load;
    /**
     * Lays the tree into the plane and derives the lines and the cells from it
     * (packages/soksak/docs/layout.md#the-model). A cut first takes its fixed costs
     * from its extent, the corridors between its kids and the px sizes of the kids
     * that keep one, and gives every other kid its fraction of the rest, so equal
     * fractions draw equal sizes; a box takes its frames, one corridor on its left,
     * right and bottom, and on its top the head of the host, from the extent of its
     * inner node. A line stands at the middle of each corridor, at its px over the
     * extent of the plane, and coordinates within EPS are one line (R1). Before the
     * plane has a size the tree is laid by its fractions alone. The corridor narrows
     * when the plane cannot hold the gaps, which the lines decide, so the tree is
     * laid again with the corridor that the first lines give.
     */
    private derive;
    /** The px size that a node keeps on an axis whatever its fraction, with its own costs, or null for a node that takes a fraction. */
    private heldOf;
    /**
     * The px size that a node keeps on an axis in two parts: `px`, the sizes that its cards declare, which a plane that cannot draw
     * them scales, and `cost`, its corridors, frames and heads, which it does not. Null for a node that takes a fraction.
     */
    private keptOf;
    /**
     * The px size of each kid of a cut along its axis, from the room inside the
     * cut (packages/soksak/docs/layout.md#the-model): the corridors between the
     * kids first, then the px sizes of the kids that keep one, and the rest to the
     * other kids by their fractions. A kid gets at least the costs inside it, its
     * own corridors, px sizes, frames and heads, and the others share what is left.
     * A fixed card with a px size is a cost of its level and keeps it while the
     * room holds the costs and one `minSize` for the kids that share; the px sizes
     * of the kids that share are scaled by one factor to leave the kids that take a
     * fraction one `minSize`; when no kid takes a fraction, they divide the room in
     * their proportion. Null when the room does not hold the costs of the kids.
     */
    private kidSizes;
    /**
     * The px of the frames and heads of the boxes that hold a node whole on an axis: a box takes one corridor on each side of x,
     * and on y its head above and one corridor below. They are costs of the cut that holds the node (R5).
     */
    private frameOf;
    /** The px that the frame of a box takes on each axis at the corridor `unit`. */
    private frameIn;
    /** The px that a node takes on an axis at no size of its cards: its corridors, px sizes, frames and heads. */
    private costOf;
    private lay;
    /**
     * Writes what the operations of the lines changed back into the tree: the
     * attributes of every card, and the share of every kid of a cut from the
     * coordinates of the lines its rectangle starts and ends at. The structure of
     * the tree stays; then the lines are derived again.
     */
    private commit;
    /** The lines on an axis at which the rectangle of a node starts and ends, as the last derive laid it. */
    private on;
    /** Puts `next` where `node` stands: in its cut, inside its box, or as the root. A cut along the axis of its cut gives that cut its kids. */
    private put;
    /** The node that leaves with the card of `leaf`: the card, or the box around it that holds nothing else. */
    private departing;
    /** Whether an id names a card or a box of the tree. */
    private taken;
    /**
     * Runs a public operation and counts the nodes that it visits in `visits`;
     * an operation that another runs adds to the count of the outer one.
     */
    private run;
    /**
     * The number of nodes of the tree that the last operation visited
     * (packages/soksak/docs/layout.md#cuts). Every operation is linear in the
     * nodes that it touches, so a test bounds this count on a large tree.
     */
    get visits(): number;
    /**
     * Sets the px that the host draws inside the top of each box by id, above its
     * inner node, which the drawn sizes and the minimum of the cut operations
     * count. The heads are no part of the state. Throws for an id that is no box
     * and for a head that is no finite number from zero, and then changes nothing.
     */
    setHeads(heads: Readonly<Record<string, number>>): void;
    resize(width: number, height: number): void;
    get width(): number;
    get height(): number;
    /**
     * Every card, as frozen copies.
     *
     * Writes to the returned objects do not affect the grid. Use `setFixed`,
     * `setSize` and `setData` to change a card.
     */
    get cards(): readonly Card[];
    card(id: string): Card | undefined;
    /**
     * Replace the payload of a card or a box.
     *
     * `data` is opaque to this library.
     */
    setData(id: string, data: unknown): boolean;
    /**
     * The frames of each card by id (R5): on each side the boxes around it that
     * end on the line of that side, which `derive` reads from the tree.
     */
    private cardFrames;
    /**
     * Set whether the layout may split, close or move a card.
     */
    setFixed(id: string, fixed: boolean): boolean;
    /**
     * Sets a card's px width or height. `null` removes the size and the card takes
     * a share of the remainder.
     *
     * The size belongs to the card in the tree, so the cells that the lines of
     * other cuts draw across it do not change it. Returns false for an unknown
     * axis or a negative or non-finite size.
     */
    setSize(id: string, axis: Axis, px: number | null): boolean;
    /** The card itself, for the operations that change it. */
    private find;
    /** Grid line coordinates, normalised 0..1. A copy — the arrangement owns them. */
    lines(axis: Axis): number[];
    /** The state: a copy of the slicing tree. */
    toJSON(): SoksakState;
    /**
     * Replace the arrangement while keeping this grid's plane and options.
     *
     * The payload is opaque to the library. This is the synchronization point
     * for a host that owns the canonical state and keeps one DOM view alive.
     */
    replace(state: SoksakState): void;
    /** Puts a state into the grid that `checkState` accepted or that `toJSON` of this grid returned. */
    private reload;
    private get plane();
    private arr;
    /** Rejects an axis value the caller invented. Every public method that takes one checks it. */
    private noAxis;
    private size;
    rectOf(card: Card): Rect;
    /**
     * The drawn rectangle of the card or the box id: a box is drawn between its lines, each inset by its corridor and by the
     * frames of the boxes around it, so its frame and its head stand inside it (R5); the heads of the boxes around it that start
     * on its top line are drawn inside its top, as inside the top of a card.
     */
    rect(id: string): Rect | undefined;
    /** The px of the heads of the boxes around the card or the box `id` that the grid draws inside the top of its rectangle. */
    headsAbove(id: string): number;
    rects(): Map<string, Rect>;
    /**
     * Where a drop lands — which card, and whether on it or beside it.
     *
     * The point is in the plane's own coordinates, the ones `rects()` reports.
     */
    zoneAt(x: number, y: number, options?: ZoneOptions): ZoneHit | null;
    /** Cards that span across a line, as frozen copies. They are what a card placed on it would cut. */
    cardsCrossing(axis: Axis, line: number): readonly Card[];
    /** How many lines a card spans across — how much finer its neighbours are. */
    crossings(card: Card): number;
    /**
     * Draws `node`, which keeps a px size on `axis`, `delta` px larger at the edge `side` that a seam moves: a card takes the
     * delta at the scale it is drawn at, a box gives it to its inner node, a cut along the axis to its kid at that edge, and a cut
     * across it to each of its kids that keeps a size.
     */
    private grow;
    /** Declares the px size `size` of the card on `axis`. */
    private declareOn;
    /** Everything to draw for the boundaries. */
    rules(): Rule[];
    dividers(): Divider[];
    /** Where a boundary is now, in px along its axis. */
    boundaryPos(axis: Axis, line: number): number;
    /**
     * Whether `line` is an interior line index.
     *
     * Index 0 and the last index are the plane's borders and are not boundaries.
     */
    hasBoundary(axis: Axis, line: number): boolean;
    /**
     * The px range a boundary may move within while every card keeps `minSize`.
     *
     * The range extends to the neighbouring lines, each the edge of a card. When the cards on both sides need more than the plane
     * holds, `lo` and `hi` are equal rather than inverted.
     *
     * The range always contains the position the boundary stands at, so a drag
     * that does not move it changes nothing.
     *
     * A boundary with a px size on exactly one side of it, on an axis the plane
     * cannot hold, reports the position it stands at twice: every way of moving it
     * changes the size a card that does not meet it is drawn at. The declared
     * sizes are scaled by one factor there, so changing one changes them all, and
     * the sharing slots always divide the same remainder between them.
     */
    boundaryRange(axis: Axis, line: number): [number, number];
    /** The seams of the cuts along `axis` that stand on the derived line `line`: each cut and the index of the kid before the seam. */
    private seams;
    /**
     * Move a boundary to a position in px.
     *
     * When either adjacent slot has a px size, that size changes. Otherwise the
     * line itself moves and every card referencing it moves with it.
     *
     * Returns the resulting position.
     */
    moveBoundary(axis: Axis, line: number, px: number, allowSnap?: boolean): number;
    /** `moveBoundary` of an axis that is one. */
    private moveLine;
    /** px per unit of normalised span across the sharing slots. */
    private sharedExtent;
    /**
     * Moves a boundary so the two cards beside it are drawn at the same size.
     *
     * A move between two declared sizes keeps their sum, so a plane that draws
     * them scaled keeps its scale, and a move between sharing cards lands where it
     * is asked: one move reaches the middle.
     */
    centerBoundary(axis: Axis, line: number): number;
    /**
     * Replaces the arrangement with an equal grid of the cards in reading order,
     * and removes every split and merge (packages/soksak/docs/layout.md#even-arrangement).
     * The grid has `rows * columns` equal to the card count `n` or `n + 1`; one
     * empty card is added when `n + 1` is chosen. Among the grids whose cells are at
     * least `minSize` on both axes, the one whose cell is closest to square is taken,
     * and a tie goes to the grid without an empty card. Returns false, and changes
     * nothing, when no grid keeps every cell at least `minSize`.
     */
    arrange(mode: 'even'): boolean;
    /**
     * ADD (packages/soksak/docs/layout.md#add-and-remove): adds `node`, a new card
     * `{card, data?}` or what `withdraw` returned, beside `target` toward `side`
     * and returns its id. `target` is an id or the ids that neighbouring kids of
     * one cut hold. Throws its refusal, a result below a minimum included, and
     * changes nothing.
     */
    insert(target: string | readonly string[], side: Side, node: TreeNode): string;
    /**
     * Whether `target` and `side` name the vacated slot of the node `id`, a card or a box (docs/spec/groups.md#vacated-slot): the node
     * itself, or the kid beside it in its cut with the side toward it, named by its id or by the members of a cut. A move there is no
     * change.
     */
    vacates(id: string, target: string | readonly string[], side: string): boolean;
    /**
     * EXCHANGE (packages/soksak/docs/layout.md#add-and-remove): puts the node `a`,
     * a card or a box, where the node `b` stands and `b` where `a` stood. Each
     * place keeps its fraction and the px size that a card there declares, and
     * every other node keeps its rectangle. Throws its refusal, a result below a
     * minimum included, and changes nothing.
     */
    exchange(a: string, b: string): void;
    /**
     * REMOVE (packages/soksak/docs/layout.md#add-and-remove): takes the node `id`,
     * a card or a box, out of its cut; the other kids that are no fixed card take
     * its fraction by one factor. Returns the node that left, which `insert` takes.
     * Throws its refusal and changes nothing.
     */
    withdraw(id: string): TreeNode;
    /**
     * The group split of the card or box `target` (packages/soksak/docs/layout.md#add-and-remove): the box `init.box` with the payload
     * `init.data` and a head of `init.head` px takes the place of `target` in its cut, with its fraction, and its inner node is a cut of two
     * halves along the axis of `side` that holds `target` and `node` toward `side`. The result is judged once with the head and the frames of
     * the new box, so a refusal names the deepest node that the group would draw below its minimum. Throws its refusal and changes nothing.
     */
    group(target: string, side: Side, node: TreeNode, init: {
        box: string;
        data?: unknown;
        head: number;
    }): void;
    /**
     * Takes the box `id` out of the tree (packages/soksak/docs/layout.md#add-and-remove): its inner node takes its place in its cut, and a
     * cut along the axis of that cut joins it with every kid drawn at the size it had. The head of the box leaves with it. Throws its refusal
     * and changes nothing.
     */
    unwrap(id: string): void;
    /** Gives the kids of every cut that take a fraction equal fractions (packages/soksak/docs/layout.md#cuts). */
    even(): void;
    /** Whether a node keeps its size on an axis whatever its fraction: a fixed card, or a node drawn at a px size there. */
    private keeps;
    /**
     * A fixed card without a px size on the axis of its cut is a fixed cost of that cut
     * (packages/soksak/docs/layout.md#the-model): after an operation it is drawn at the size it had before, and the kids that take a
     * fraction share the rest in the ratio of their fractions. Its fraction is the one that draws that size.
     */
    private keepFixed;
    /** What an operation of the cuts reads of the grid, on the stored tree itself. */
    private input;
    /**
     * Installs the stored tree that `make` makes of the stored tree and lays it. A
     * result that draws a node that it changed below its minimum throws its text.
     * A throw puts the arrangement back.
     */
    private byCuts;
    /**
     * The drawn extent of a node, the extent of the drawn rectangles of its cards, and its recursive minimum on an axis
     * (packages/soksak/docs/layout.md#cuts), read from the rectangles `now`; `before` holds the rectangles that a fixed card had.
     */
    private measure;
    /**
     * The text of the deepest node whose drawn rectangle the last operation
     * changed and that is drawn below its minimum, or null: the first such node in
     * the depth-first order of the tree, a box after the nodes inside it. The
     * rectangle of a card is its own, that of a box the extent of the cards inside
     * it. The minimum of a node is recursive: a card
     * needs `minSize` and on y the heads drawn inside its rectangle, a card that
     * keeps a px size the smaller of that size and `minSize`, a fixed card with a
     * px size the smaller of that size and the size it had, another fixed card the
     * size it is drawn at, a box the minimum of its
     * inner node, a cut along an axis the minimums of its kids and the corridors
     * between them, and a cut across it the largest minimum of its kids.
     */
    private belowMinimum;
    /**
     * Where the two cards meeting at a boundary come out the same size.
     *
     * This is not the midpoint of the two lines: a card at the plane's border
     * insets on one side only.
     */
    private middleOf;
    /**
     * Returns the position to cut a card at.
     *
     * Prefers the unreferenced line nearest the card's centre that leaves both
     * halves at `minSize`. Otherwise returns a new line at the centre, clamped to
     * the range where both halves fit. `newLine` takes no existing line.
     */
    private cutAt;
    /** The smallest drawn side of every card, by id. Used to compare before and after a change. */
    private extents;
    /** The cards drawn with no width or no height, by id. */
    private flat;
    /**
     * Whether every card is drawn with a non-zero width and height.
     *
     * `flat` names the cards that already had none before the change. R5 lets a
     * card whose own two lines stand at one place sit inside the one gap that
     * keeps its neighbours apart, so such a card is left where it is: judging it
     * here refused every split, travel and insert anywhere on a plane holding
     * one, however much room the operation had.
     */
    private hasArea;
    /**
     * Whether every card still has the smaller of the size it had and `minSize`.
     *
     * A new line adds a gap, taken from the sharing slots, so a split can reduce a
     * card elsewhere on the plane.
     */
    private stillFits;
    /** Whether `split` of the card `id` along `axis` would succeed. */
    canSplit(id: string, axis: Axis): boolean;
    /**
     * Cut one card in two.
     *
     * The original keeps its id and the near half; the new card takes the far
     * half. In the tree the card becomes two kids of its cut when the cut is
     * along the axis, and otherwise a new cut of the two in its place.
     *
     * The new card has no `data` unless `init.data` is given. A px size on the
     * other axis is copied, because both halves stay in that slot. A px size on
     * the cut axis is divided between them.
     *
     * `init.newLine` cuts at a new line at the centre even where a line that the
     * card spans across lies inside it, for a host that places the line itself.
     *
     * Returns the new card's id. Throws its refusal and changes nothing: an
     * unknown axis, an id that the layout holds, an unknown or fixed card, a card
     * drawn no wider than the corridor of the cut, and a cut that draws a node
     * below its minimum, which names the deepest such node.
     */
    split(id: string, axis: Axis, init?: {
        id?: string;
        data?: unknown;
        newLine?: boolean;
    }): string;
    /**
     * Cut a card and put the new one on a named side. The ids are not swapped:
     * toward `left` and `top` the new card takes the near part. Its refusal is
     * the refusal of `split`.
     */
    splitToward(id: string, side: Side, init?: {
        id?: string;
        data?: unknown;
        newLine?: boolean;
    }): string;
    /**
     * Cuts the card `id` along `axis` at the position of `cutAt`: the card keeps
     * its part of the extent before the cut and the new card takes the part after
     * it, or with `first` the new card takes the part before it.
     */
    private splitAt;
    private nextId;
    /**
     * Whether a kid is a fixed card, which keeps its size when a sibling leaves. A
     * cut or a box that holds a fixed card is not fixed: its other cards take the
     * share, and its fixed card keeps its size by the rule of its own cut.
     */
    private holdsFixed;
    private removable;
    /** Whether `close` would remove the card or the box `id`. */
    canClose(id: string): boolean;
    /**
     * Whether the box `id` can close: a card that is not fixed stands outside it, and its cut holds another kid that is no fixed card,
     * which takes its share.
     */
    private boxClosing;
    /**
     * The cut that holds the node leaving with the card `id` and its index in
     * that cut, or null when the card cannot close: it is fixed or the last card,
     * or every other kid of its cut holds a fixed card.
     */
    private closing;
    /**
     * Remove a card, or a box with every card inside it (packages/soksak/docs/layout.md#add-and-remove): the node that
     * leaves with it goes out of its cut, and the fractions of the other kids of
     * the cut that are no fixed card scale by one factor, so their ratios hold; a
     * fixed card keeps the size it is drawn at. Returns false, and changes nothing,
     * when the card is `fixed`, when it is the last card or the box holds every card
     * that is not fixed, or when every other kid of its cut is a fixed card.
     */
    close(id: string): boolean;
    private closeAlong;
    /**
     * Whether a card spanning the whole plane can be placed on this boundary:
     * the line is an edge of the plane or a seam of the root cut along `axis`.
     * No card crosses such a line, and a line that no card crosses but that two
     * cuts share by chance is no seam, so nothing stands there.
     */
    canInsertAt(axis: Axis, line: number): boolean;
    /**
     * Where a card spanning the whole plane on the other axis goes in at `line`:
     * the index among the kids of the root, which is a cut along `axis` or becomes
     * one, or null when `line` is no edge of the plane and no seam of the root. A
     * line that no card crosses but that two cuts of the root share by chance is
     * no seam of the root, so nothing goes in there.
     */
    private standing;
    /**
     * Inserts a card at a boundary, spanning the whole plane on the other axis,
     * as a kid of the root cut along `axis`.
     *
     * `size` is required, in px, and must be smaller than the plane. A boundary
     * between kids i and i + 1 of the root is the add of the card beside kid i
     * toward kid i + 1 (packages/soksak/docs/layout.md#boundaries): when the kids
     * that hold no px size on the axis have one drawn size, or kid i holds one,
     * every kid gives a share in proportion and keeps its ratio; otherwise kid i
     * alone gives the span and every other kid keeps its size. An edge of the
     * plane is the add beside the root as a whole, so every kid gives a share in
     * proportion.
     *
     * Returns the new card's id, or null when a card spans the boundary, the line
     * is no seam of the root, the size is invalid, or the result would leave a
     * card with no area or below the size it had and `minSize`.
     */
    insertAt(axis: Axis, line: number, init: {
        id?: string;
        data?: unknown;
        size: number;
    }): string | null;
    /**
     * Moves a card that spans the whole plane, a kid of the root cut along `axis`,
     * to another boundary of the root: its kid moves to that place with its share,
     * the kids it passes shift by its span and every other line keeps its
     * coordinate. `fixed` blocks the layout, not a direct call from the host, so a
     * fixed card may be moved.
     *
     * `line` is an index in the current arrangement.
     */
    moveTo(id: string, axis: Axis, line: number): boolean;
    /**
     * Every boundary a plane-spanning card could stand on: the two edges of the
     * plane and the seams of the root cut along `axis`, in order. A card that
     * stands on one of them blocks none of them.
     */
    standings(axis: Axis): number[];
    /**
     * Moves a card to one side of another. This is the drag-and-drop operation.
     *
     * One operation rather than a close and a split sequenced by the caller,
     * because the order matters: the close returns the space first and changes the
     * target's geometry, so the cut is measured after it. A close that cannot
     * happen leaves the arrangement unchanged instead of half changed.
     *
     * The card keeps its id and its payload, so the host's element is reused and a
     * live surface inside it is not destroyed. It keeps its px size only when it
     * lands spanning one slot on that axis.
     */
    move(id: string, targetId: string, side: Side): boolean;
    /** Whether `move` would succeed, without performing it. */
    canMove(id: string, targetId: string, side: Side): boolean;
    /**
     * Runs after every operation that changes the arrangement: the sizes agree,
     * and the tree takes the lines and the attributes of the cards.
     *
     * A px size describes one slot, so a card that comes to span two loses it. The
     * value is removed rather than kept for a later split to reapply.
     */
    private changed;
    /** Restores the arrangement to a state returned earlier by `toJSON`. */
    private restore;
}
