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
import type { Divider, Frames, Rule, ZoneHit, ZoneOptions } from './geometry.js';
export type { Divider, Rule, Zone, ZoneHit, ZoneOptions } from './geometry.js';
import type { Fill, FillOrder } from './slicing.js';
import type { SoksakState, TreeNode } from './tree.js';
export type { Axis, Card, CardInit, Rect, Side } from './card.js';
export type { Fill, FillOrder } from './slicing.js';
export type { BoxNode, CardNode, CutNode, Kid, SoksakState, TreeNode } from './tree.js';
export { checkState } from './tree.js';
/** `merge`: a dragged boundary snaps onto a neighbouring line and the two combine. */
export type SnapMode = 'merge' | 'off';
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
    /** Which axis a fill walks first. Default `v`. */
    fillOrder?: FillOrder;
    /** Plane width in px. Default 0 until `resize`. */
    width?: number;
    /** Plane height in px. Default 0 until `resize`. */
    height?: number;
}
export declare class Soksak {
    /** The state: the slicing tree of the plane, and the card that each card took its space from. */
    private root;
    /**
     * Which card each card took its space from, by id. `split` and `insertAt`
     * record it, and a close gives the space back to that card when it stands
     * beside it in the same cut, so the two operations are inverses; `''` names
     * a card that took a share of every kid of the root.
     */
    private paidBy;
    private xs;
    private ys;
    private list;
    private byId;
    private leaves;
    private boxes;
    private at;
    private spots;
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
    private order;
    /** The axis a close tries first. */
    get fillOrder(): FillOrder;
    /** The sides a close tries, in the order of `fillOrder`. */
    get fillSides(): readonly Fill['side'][];
    set fillOrder(value: FillOrder);
    private grab;
    /** Smallest grab area of a boundary, in px. */
    get grabSize(): number;
    set grabSize(px: number);
    private snapAt;
    /** How near a dragged boundary must come to a neighbour to land on it, in px. */
    get snapDistance(): number;
    set snapDistance(px: number);
    private snapMode;
    /** Whether a dragged boundary lands on a neighbour it nearly meets. */
    get snap(): SnapMode;
    set snap(mode: SnapMode);
    constructor(state?: SoksakState, options?: SoksakOptions);
    static from(state: SoksakState, options?: SoksakOptions): Soksak;
    /** Takes the tree and the payers of a state as copies and derives the lines and the cells. */
    private load;
    /**
     * Lays the tree into the unit plane and derives the lines and the cells from
     * it: coordinates within EPS are one line (R1), and the cards are listed in
     * the order of the tree. Each node keeps the lines its rectangle starts and
     * ends at and the node that holds it, so no operation searches the tree.
     */
    private derive;
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
    /**
     * Takes the kid `i` out of the cut `holder` and gives its share to the kid
     * `to`, or to every other kid in proportion to its share when `to` is -1. A cut
     * left with one kid is replaced by that kid.
     */
    private drop;
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
     * Replace a card's payload.
     *
     * `data` is opaque to this library.
     */
    setData(id: string, data: unknown): boolean;
    /** The frames of each card by id that `setFrames` set (R5). */
    private cardFrames;
    /**
     * Sets the frames between each card and its four lines (R5): a card without an
     * entry, and a side without a count, has none. The frames are no part of the
     * state. Throws for an id that is no card and for a count that is no whole
     * number from zero, and then changes nothing.
     */
    setFrames(frames: Readonly<Record<string, Partial<Frames>>>): void;
    /**
     * Set whether the layout may split, close or move a card.
     */
    setFixed(id: string, fixed: boolean): boolean;
    /**
     * Sets a card's px width or height. `null` removes the size and the card takes
     * a share of the remainder.
     *
     * The size applies to the slot, so it is written to every card in that slot.
     * Returns false for an unknown axis, a negative or non-finite size, or a card
     * spanning more than one slot on that axis.
     */
    setSize(id: string, axis: Axis, px: number | null): boolean;
    /** The card itself, for the operations that change it. */
    private find;
    /** Grid line coordinates, normalised 0..1. A copy — the arrangement owns them. */
    lines(axis: Axis): number[];
    /** The state: a copy of the slicing tree and of the payers. */
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
    rect(id: string): Rect | undefined;
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
    /** Set the px size every card in a slot declares. */
    private declare;
    /**
     * Whether every card the settle can reach meets its minimum.
     *
     * `settleOn` names one sharing slot to absorb a difference, and only the
     * sharing slots change width by that choice: a slot with a px size is drawn
     * what it declares whichever slot pays. A card standing entirely in such
     * slots is therefore not judged here. Judging it refused every candidate
     * whenever the host declared a size below `minSize`, and the space went to
     * the sharing slots together instead of to the slot beside the boundary.
     */
    private fits;
    /**
     * Writes the widths in `want` to the sharing slots by moving the lines between
     * them. An entry of `null` leaves that slot to share the remainder in
     * proportion to its span.
     *
     * Slots with a px size are skipped: that size is the host's and `want` does
     * not override it. Only the lines around the named slots move.
     */
    private setSlotWidths;
    /**
     * Applies `want`, letting one sharing slot absorb the difference.
     *
     * `order` lists the candidate slots, nearest the boundary first. Each is set
     * to `null` in turn, written, and measured; the first that keeps every card at
     * `minSize` is kept and the rest are restored. If none does, every sharing
     * slot is set to `null` and they share the difference.
     *
     * Measuring after writing means the sizes come from `slotSizes` and are not
     * predicted separately.
     *
     * Returns the slot that absorbed the difference, or -1.
     */
    private settleOn;
    /**
     * Whether every sharing slot `want` named is drawn at the width it named.
     *
     * `setSlotWidths` divides the room the sharing slots hold between them, so a
     * set of names that asks for more than that room is met by scaling all of
     * them down. Every slot then gives a share, and the one set to `null` is not
     * the one that paid.
     */
    private namedKept;
    /**
     * Draws one slot at `drawn` px and takes the difference from `pays`, the slot
     * on the other side of the boundary.
     *
     * `drawn` is a size read off the plane, and what a slot declares is drawn
     * scaled when the plane cannot hold every declared size, so each slot declares
     * the size that draws at the width asked for.
     *
     * A drag moves one boundary, so only those two slots change. Both indices come
     * from that boundary and are therefore in range and never equal.
     */
    private resizeSlot;
    /**
     * The card whose px size a drag at this boundary changes, if either slot
     * meeting there has one. Every card in that slot takes the new size.
     */
    private holderAt;
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
     * A plane too small for the sizes its cards declare draws them scaled, and the
     * move changes that scale, so the position asked for is not the position
     * reached. The middle is measured again after each move. A plane that holds
     * its declared sizes reaches it in one.
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
     * REMOVE (packages/soksak/docs/layout.md#add-and-remove): takes the node `id`,
     * a card or a box, out of its cut; the other kids take its space in proportion
     * to their sizes. Returns the node that left, which `insert` takes. Throws its
     * refusal and changes nothing.
     */
    withdraw(id: string): TreeNode;
    /** Gives every kid of every cut an equal share (packages/soksak/docs/layout.md#cuts). */
    even(): void;
    /**
     * Installs the tree of the plan that `make` makes of the stored tree and its
     * drawn rectangles, with the paidBy records of the grid. The plan lays its
     * cuts, the grid draws them, and the plan corrects its spans by what was drawn
     * until the largest error is below a thousandth of a px; a corridor does not
     * change with a span, so this takes one correction, and one more for each
     * nested cut that moved. A result that draws a changed node below its minimum
     * throws its text. A throw puts the arrangement back.
     */
    private byCuts;
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
    /** True when the cut leaves every card the smaller of its current size and `minSize`. */
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
     * Returns the new card's id, or null when the halves do not fit.
     */
    split(id: string, axis: Axis, init?: {
        id?: string;
        data?: unknown;
        newLine?: boolean;
    }): string | null;
    /**
     * Cut a card and put the new one on a named side. The ids are not swapped:
     * toward `left` and `top` the new card takes the near part.
     */
    splitToward(id: string, side: Side, init?: {
        id?: string;
        data?: unknown;
        newLine?: boolean;
    }): string | null;
    /**
     * Cuts the card `id` along `axis` at the position of `cutAt`: the card keeps
     * its part of the extent before the cut and the new card takes the part after
     * it, or with `first` the new card takes the part before it. The new card is
     * recorded as paid by the card.
     */
    private splitAt;
    private nextId;
    /**
     * The neighbours that would expand over a card if it closed, as frozen copies:
     * the cards of the kid of its cut beside it toward the first of `sides` that
     * names a kid without a fixed card, or null. `sides` names the sides to try
     * in their order, the sides of `fillOrder` by default.
     */
    fill(id: string, sides?: readonly Fill['side'][]): Fill | null;
    /**
     * The neighbour that takes the space of the card `id` when it closes: the kid
     * of the cut of the card beside it toward the first of `sides` that holds no
     * fixed card, or null. A close gives the space to a kid of the card's own
     * cut, so it never crosses the structure of another cut.
     */
    private fillAlong;
    /**
     * The index of the kid of `holder` that holds the card `id`, or -1 when no
     * kid holds it. The walk goes up from the card, so it visits the depth of
     * the card and no other node.
     */
    private kidHolding;
    /** Whether a fixed card stands inside a node. */
    private holdsFixed;
    private removable;
    /** Whether `close` would remove the card. */
    canClose(id: string): boolean;
    /**
     * The cut that holds the node leaving with the card `id`, the kid that takes
     * its space, -1 for every other kid in proportion to its share, and whether
     * that kid grows over the space as a neighbour. The kid of its cut that holds
     * the card it took its space from takes it when that kid holds no fixed card;
     * the kids between the two shift by the span. Otherwise a kid of the root
     * cut that took its space gives it back to every kid in proportion when it
     * took a share of every kid (paidBy `''`), else to the kid after it, or before
     * it at the end of the plane. Otherwise the neighbour of the first of `sides`
     * that fills it takes it, else every other kid in proportion. It
     * is null when the card cannot close: it is fixed or the last card, or no kid
     * of its cut without a fixed card can take the space.
     */
    private closing;
    /**
     * Remove a card. Its space goes to a kid of its own cut: the card it took its
     * space from when that card stands beside it, else the neighbour that the
     * first of `sides` names, else every other kid in proportion to its share.
     * Returns false when the card is `fixed`, when it is the last card, or when no
     * kid of its cut without a fixed card can take the space. `sides` names the
     * sides whose neighbour may expand, tried in their order, the sides of
     * `fillOrder` by default; an empty list gives the space to every kid in
     * proportion. A host that keeps its own regions of cards passes one side at a
     * time.
     */
    close(id: string, sides?: readonly Fill['side'][]): boolean;
    private closeAlong;
    /**
     * The slots of the lines of kid `i` of `holder`, which leave with it, when
     * `holder` spans the plane across its axis and kid `to` takes the span: every
     * line of the range of such a cut is a line of its kids, so each other slot of
     * the axis stands after the drop at its index less the slots that left.
     * Null for a cut that does not span the plane, whose lines share their places
     * with the lines of other cuts.
     */
    private leavingSlots;
    /**
     * Draws again every slot of `axis` that stood between the same two lines
     * before a change at the width it had, where the axis had or has a card with
     * a px size: the slots that the change made share what is left, the slots of
     * the card `payer` first absorbing the difference. On an axis that had and has
     * no px size the coordinates are already the drawn sizes and nothing moves.
     * `leaving` names the slots that left with a kid of a cut that spans the plane
     * (`leavingSlots`); every other slot then pairs with the slot of its index.
     */
    private settle;
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
     * `size` is required, in px, and must be smaller than the plane. The new kid
     * takes its span from the kid after it, else from the kid before it, else
     * from every kid in proportion, and every other slot is drawn at the width it
     * had.
     *
     * Returns the new card's id, or null when a card spans the boundary, the line
     * is no seam of the root, the size is invalid, or the result would leave a
     * card with no area.
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
     * lands spanning one slot on that axis. `sides` is the sides of the close, as
     * `close` takes them.
     */
    move(id: string, targetId: string, side: Side, sides?: readonly Fill['side'][]): boolean;
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
    /**
     * Writes the largest declared px size to every card in a slot, and removes the
     * size from a card that no longer spans one slot.
     *
     * A slot has one width, so two cards in it cannot declare different sizes.
     * `heldSizes` reads the largest and this writes it back, so `toJSON` reports
     * what is drawn. Called wherever cards are added or moved.
     */
    private agreeSizes;
    /** Restores the arrangement to a state returned earlier by `toJSON`. */
    private restore;
}
