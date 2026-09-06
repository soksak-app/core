/**
 * A soksak over shared grid lines.
 *
 * `xs` and `ys` hold every coordinate, normalised 0..1 over the slots that
 * share the remaining space. A slot with a px size is drawn at that size
 * whatever its span, so a line's px position is not its value times the plane
 * size. A card is a span of indices into them, so two cards that meet reference
 * the same index and their shared boundary is one value. Moving a line moves
 * every card that references it; a card spanning across it is unaffected.
 *
 * Splitting replaces one card with two, so the arrangement stays a slicing
 * floorplan and every card can be closed.
 *
 * This module holds the state and the operations. `geometry.ts` computes the
 * coordinates.
 */
import type { Axis, Card, CardInit, Rect, Side } from './card.js';
import type { Divider, Rule, ZoneHit, ZoneOptions } from './geometry.js';
export type { Divider, Rule, Zone, ZoneHit, ZoneOptions } from './geometry.js';
import type { Fill, FillOrder, Span } from './slicing.js';
export type { Axis, Card, CardInit, Rect, Side } from './card.js';
export type { Fill, FillOrder } from './slicing.js';
/** `merge`: a dragged boundary snaps onto a neighbouring line and the two combine. */
export type SnapMode = 'merge' | 'off';
/**
 * Where a card's slot came from: the side and the card its width came from, and
 * the side its span came from.
 *
 * The two sides differ whenever the slot next to the boundary could not give the
 * width and one further out did. `span` is absent on a state saved before it was
 * recorded, and on a card that a split made.
 */
export interface Paid {
    side: 'lo' | 'hi';
    to: string;
    span?: 'lo' | 'hi' | 'all';
    /** Which of `to`'s slots gave the width, counted from its first. */
    at?: number;
}
export interface SoksakState {
    xs: number[];
    ys: number[];
    cards: CardInit[];
    /**
     * Which side each card took its slot from, by id.
     *
     * A close returns the slot to the neighbour it came from, so this decides
     * where the space goes. It is part of the state: without it a grid built from
     * `toJSON` draws the same rects but closes cards differently.
     */
    paidBy?: Record<string, Paid>;
}
export interface SoksakOptions {
    /** Gap between two cards, in px. Half of it insets every inner edge. Default 24. */
    gap?: number;
    /** Smallest card edge, in px. Splitting, dragging and resizing all respect it. Default 96. */
    minSize?: number;
    /** Smallest hit area, in px. Independent of `gap` so a zero gap is still draggable. Default 11. */
    grabSize?: number;
    /** How close a dragged boundary must come to a neighbour to snap onto it, in px. Default 7. */
    snapDistance?: number;
    snap?: SnapMode;
    fillOrder?: FillOrder;
    width?: number;
    height?: number;
}
/**
 * Rejects a state that cannot describe a plane and reports which field is wrong.
 *
 * Without this check a stale layout read from storage reaches the geometry,
 * where an index outside the line array or a non-numeric coordinate produces a
 * NaN rect. In the DOM that becomes `left: NaNpx`, which the CSSOM discards, so
 * the view stops at its last valid layout and reports nothing.
 */
export declare function checkState(state: SoksakState): void;
export declare class Soksak {
    private xs;
    private ys;
    private list;
    private w;
    private h;
    private seq;
    private sliceMemo;
    private splitMemo;
    /**
     * Which side of a card's slot gave up the span it occupies, by card id.
     *
     * `split` and `insertAt` take the span from one neighbour. A close returns it
     * by removing the line on that side, so the two operations are inverses.
     * Without this the space goes to whichever neighbour the fill selects, and
     * repeating split and close reduces one card to `minSize`.
     */
    private paidBy;
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
    /** With no state, starts as one card filling the plane. */
    constructor(state?: SoksakState, options?: SoksakOptions);
    static from(state: SoksakState, options?: SoksakOptions): Soksak;
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
    toJSON(): SoksakState;
    /**
     * Replace the arrangement while keeping this grid's plane and options.
     *
     * The payload is opaque to the library. This is the synchronization point
     * for a host that owns the canonical state and keeps one DOM view alive.
     */
    replace(state: SoksakState): void;
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
    /** True when no card reads this line — it survives only as a snap target. */
    isVirtual(axis: Axis, line: number): boolean;
    virtualCount(): number;
    isSlicing(list?: readonly Span[]): boolean;
    /** Set the px size every card in a slot declares. */
    private declare;
    /** Whether every card meets its minimum at the current plane size. */
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
    /** The nearest line on that side that at least one card references. */
    private realNeighbour;
    /**
     * Whether `line` is an interior line index.
     *
     * Index 0 and the last index are the plane's borders and are not boundaries.
     */
    hasBoundary(axis: Axis, line: number): boolean;
    /**
     * The px range a boundary may move within while every card keeps `minSize`.
     *
     * The range extends to the nearest line a card references; unreferenced lines
     * do not limit it. When the cards on both sides need more than the plane
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
    /**
     * Removes the unreferenced lines the move passes and returns the new index of
     * the moved line.
     *
     * Leaving a passed line in place would put the array out of order.
     */
    private forgetLinesPassed;
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
     * Where the two cards meeting at a boundary come out the same size.
     *
     * This is not the midpoint of the two lines: a card at the plane's border
     * insets on one side only.
     */
    private middleOf;
    /**
     * Merges a line onto a neighbour at the same coordinate.
     *
     * Returns false when a card spans both lines, which would leave it zero size.
     */
    mergeCoincident(axis: Axis, line: number): boolean;
    /** Removes lines no card references. Returns how many were removed. */
    tidy(): number;
    /**
     * Returns the position to cut a card at.
     *
     * Prefers the unreferenced line nearest the card's centre that leaves both
     * halves at `minSize`. Otherwise returns a new line at the centre, clamped to
     * the range where both halves fit.
     */
    private cutAt;
    /** The smallest drawn side of every card, by id. Used to compare before and after a change. */
    private extents;
    /** Whether every card is drawn with a non-zero width and height. */
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
     * half. Cards spanning the new line have their span widened rather than cut.
     *
     * The new card has no `data` unless `init.data` is given. A px size on the
     * other axis is copied, because both halves stay in that slot. A px size on
     * the cut axis is divided between them.
     *
     * Returns the new card's id, or null when the halves do not fit.
     */
    split(id: string, axis: Axis, init?: {
        id?: string;
        data?: unknown;
    }): string | null;
    /**
     * Cut a card and put the new one on a named side.
     *
     * `split` gives the far half to the new card, so `left` and `top` swap the two
     * spans afterwards. The ids are not swapped.
     */
    splitToward(id: string, side: Side, init?: {
        id?: string;
        data?: unknown;
    }): string | null;
    private nextId;
    /**
     * The neighbours that would expand over a card if it closed, as frozen copies.
     *
     * Returns null when no row of neighbours matches a side. `close` then removes
     * the card's slots instead.
     */
    fill(id: string): Fill | null;
    /** The same result holding the stored cards, so `close` can modify them. */
    private fillOf;
    /**
     * The axis whose slots hold no other card, or null.
     *
     * On that axis the card's slots can be removed when it closes, with no
     * neighbour expanding over it. Returns null when another card lies entirely
     * inside the range, because removing the slots would leave it spanning nothing.
     */
    private soleSlots;
    private removable;
    canClose(id: string): boolean;
    /**
     * Remove a card.
     *
     * A row of neighbours expands over the space when one matches the side.
     * Otherwise the card's slots are removed. Returns false when neither applies,
     * when the card is `fixed`, or when it is the last card.
     */
    close(id: string): boolean;
    /**
     * Restores unreferenced lines to their previous px positions.
     *
     * The coordinate that produces a given px position has no closed form, because
     * a slot's size depends on every other slot. It is found by iteration: each
     * pass moves the coordinate by the error divided by the slope, and the error
     * falls fast enough that a few passes reach it exactly.
     */
    private standAgain;
    /**
     * Whether a card spanning the whole plane can be placed on this boundary.
     *
     * True when no card spans across the line. `without` excludes one card by id.
     */
    canInsertAt(axis: Axis, line: number, without?: string): boolean;
    /**
     * Inserts a card at a boundary, spanning the whole plane on the other axis.
     *
     * Unlike `splitToward`, the new card is not cut from one card. Cards past the
     * boundary shift by one index.
     *
     * `size` is required, in px, and must be smaller than the plane. It is
     * converted to a span in proportion to the plane.
     *
     * Returns the new card's id, or null when a card spans the boundary, the size
     * is invalid, or the result would leave a card with no area.
     */
    insertAt(axis: Axis, line: number, init: {
        id?: string;
        data?: unknown;
        size: number;
    }): string | null;
    /** Whether a card occupies one slot on one axis and spans the whole other axis. */
    private spansPlane;
    /**
     * Insert a slot at a boundary with the given span. Returns the side the span
     * came from, or 'all' when every slot gave a share of it.
     *
     * Every other slot is scaled by `1 - span`. A card ending at the boundary
     * keeps its index and a card starting there shifts by one.
     */
    private openSlot;
    /**
     * Open a slot at a boundary and shift the spans that referenced it.
     *
     * A card that starts on the line moves past the new slot; a card that ends on
     * it keeps its index. `removeLine(axis, line, 'hi')` is the inverse.
     */
    private openIndex;
    /**
     * Remove one line and shift the spans that referenced it.
     *
     * `into` selects which neighbouring slot absorbs the removed one, which decides
     * whether a card ending on the line follows it or extends past it.
     */
    private removeLine;
    /**
     * Remove one slot by removing a line beside it.
     *
     * Removes the far line, or the near one for the last slot, so the plane's two
     * borders are never removed.
     */
    private dropSlot;
    /**
     * Move a plane-spanning card to another boundary.
     *
     * The card's slot is removed and a slot of the same span is inserted at the
     * target. No other card's spans change and no line on the other axis moves.
     *
     * `line` is an index in the current arrangement.
     */
    moveTo(id: string, axis: Axis, line: number): boolean;
    /**
     * Every boundary a plane-spanning card could stand on.
     *
     * `without` excludes one card by id, so a card already placed can query the
     * other boundaries without blocking itself.
     */
    standings(axis: Axis, without?: string): number[];
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
     * Runs after every operation that changes the arrangement.
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
