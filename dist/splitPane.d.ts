/**
 * A soksak over shared grid lines.
 *
 * `xs` and `ys` hold every coordinate, normalised 0..1 over the slots that
 * share what is left. A slot held at a px size is drawn at that size whatever
 * its span, so a line's position in px is not its number times the plane. A
 * card is a span of indices into them, so two cards that meet read the same
 * index and their shared boundary is one number. Moving a line moves every card that
 * references it; a card spanning across the line is unaffected.
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
/** `merge`: a dragged boundary snaps onto a neighbouring line and the two become one. */
export type SnapMode = 'merge' | 'off';
/** Where a card's slot came from: which side of it, and the card that gave it. */
export interface Paid {
    side: 'lo' | 'hi';
    to: string;
}
export interface SoksakState {
    xs: number[];
    ys: number[];
    cards: CardInit[];
    /**
     * Which side each card took its slot from, by id.
     *
     * A close hands the slot back to the neighbour that gave it up, so this
     * decides where the room goes. It is part of the state: without it a grid
     * built from `toJSON` draws the same rects but closes cards differently.
     */
    paidBy?: Record<string, Paid>;
}
export interface SoksakOptions {
    /** Corridor between two cards, in px. Half of it insets every inner edge. Default 24. */
    gap?: number;
    /** Smallest card edge, in px. Splitting, dragging and resizing all respect it. Default 96. */
    minSize?: number;
    /** Smallest grab area, in px. Kept apart from `gap` so a zero corridor is still grabbable. Default 11. */
    grabSize?: number;
    /** How close a dragged boundary must come to a neighbour to snap onto it, in px. Default 7. */
    snapDistance?: number;
    snap?: SnapMode;
    fillOrder?: FillOrder;
    width?: number;
    height?: number;
}
/**
 * Refuse a state that cannot describe a plane, naming what is wrong.
 *
 * A stale layout read back from storage otherwise reaches the geometry, where
 * an index outside the line array or a coordinate that is not a number turns
 * into a NaN rect. In the DOM that becomes `left: NaNpx`, which the CSSOM
 * drops, so the view freezes at its last good layout with nothing to report.
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
     * by removing the line on that side, so the two are inverses. Without this
     * the space moves to whichever neighbour the fill picks, and repeating the
     * pair drives one card to `minSize`.
     */
    private paidBy;
    /** True while canSplit runs a trial split and restores the state. */
    private probing;
    private g;
    /** Corridor between two cards, in px. Never negative — a card would overlap. */
    get gap(): number;
    set gap(px: number);
    private min;
    /** The smallest a card may be drawn on either axis. */
    get minSize(): number;
    /** Writing it clears the cached answers that were computed against the old one. */
    set minSize(px: number);
    private order;
    /** Which axis a close tries first. */
    get fillOrder(): FillOrder;
    set fillOrder(value: FillOrder);
    grabSize: number;
    snapDistance: number;
    snap: SnapMode;
    /** Without a state, starts as one card filling the plane. */
    constructor(state?: SoksakState, options?: SoksakOptions);
    static from(state: SoksakState, options?: SoksakOptions): Soksak;
    resize(width: number, height: number): void;
    get width(): number;
    get height(): number;
    /**
     * Every card, as frozen copies.
     *
     * Writes to the returned objects do not reach the grid. Use `setFixed`,
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
     * Set a card's px width or height, or `null` for a share of what is left.
     *
     * Applies to a card spanning one slot on that axis. Sets the slot, so every
     * card in it takes the same size. Returns false when the axis or size is
     * invalid or the card spans more than one slot.
     */
    setSize(id: string, axis: Axis, px: number | null): boolean;
    /** The card itself, for the operations that change it. */
    private find;
    /** Grid line coordinates, normalised 0..1. A copy — the arrangement owns them. */
    lines(axis: Axis): number[];
    toJSON(): SoksakState;
    private get plane();
    private arr;
    /** An axis the caller made up. Every public method that takes one refuses. */
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
    /** Whether every card has its minimum, as the plane stands. */
    private fits;
    /**
     * Give each sharing slot the width `want` names for it. A slot named `null`
     * takes what is left over, shared with the other `null` slots in proportion
     * to the span it holds.
     *
     * A px size is declared by the host, so this never changes one: a held slot
     * keeps its size whatever `want` says. Naming the widths settles a change
     * with the slots it touches and leaves the rest where they are.
     */
    private setSlotWidths;
    /**
     * Settle a change with the sharing slot nearest the boundary.
     *
     * `order` lists the slots to try, nearest first. The first one that leaves
     * every card its minimum takes the room; when none does, every sharing slot
     * shares it. Each candidate is applied and then measured, so the slot sizes
     * come from `slotSizes` alone and no second calculation can disagree with it.
     *
     * Returns the slot that took the room, or -1.
     */
    private settleOn;
    /**
     * Set one slot's px size and take the difference from the slot on the other
     * side of the boundary.
     *
     * A drag moves one boundary: the two slots meeting there change and no other
     * slot does. `slot` and `pays` are the two slots a boundary separates, so
     * they are always in range and never the same one.
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
    /** The nearest line on this side that some card actually reads. */
    private realNeighbour;
    /**
     * Whether `line` is an interior line index.
     *
     * Index 0 and the last index are the plane's borders and are not boundaries.
     */
    hasBoundary(axis: Axis, line: number): boolean;
    /**
     * How far a boundary may travel before a card would fall under `minSize`.
     *
     * The range reaches to the nearest line a card references; lines no card
     * references do not constrain it. When two cards ask for more room than the
     * plane holds it is one point, never an inverted pair.
     */
    boundaryRange(axis: Axis, line: number): [number, number];
    /**
     * Move a boundary to a position in px.
     *
     * Next to a slot with a px size, this changes that size. Otherwise it moves
     * the line and every card referencing it follows.
     *
     * Returns the resulting position.
     */
    moveBoundary(axis: Axis, line: number, px: number, allowSnap?: boolean): number;
    /**
     * Remove the unreferenced lines a move passes, and return the moved index.
     *
     * A line the move has passed would leave the array out of order.
     */
    private forgetLinesPassed;
    /** How many px the sharing slots have between them, per unit of normalised span. */
    private sharedExtent;
    /**
     * Move a boundary so the two cards beside it are the same size.
     *
     * Not the midpoint of the two lines: a card at the plane's border insets on
     * one side only.
     */
    centerBoundary(axis: Axis, line: number): number;
    /**
     * Merge a line onto a neighbour at the same coordinate.
     *
     * Returns false when a card spans the pair, which would leave it with no size.
     */
    mergeCoincident(axis: Axis, line: number): boolean;
    /** Drop lines no card reads any more. Returns how many went. */
    tidy(): number;
    /**
     * Where to cut.
     *
     * The unreferenced line nearest the card's centre that leaves both halves at
     * `minSize`; otherwise a new line at the centre, clamped to the range that
     * fits.
     */
    private cutAt;
    /** The smallest side every card has, so a change can be asked what it cost. */
    private extents;
    /** Whether every card is drawn with area. A card with none is not a card. */
    private hasArea;
    /**
     * Whether every card still has the room it had, or `minSize`, whichever is
     * less.
     *
     * A new line adds a corridor, which is taken from the shared slots, so a
     * split can push a card elsewhere below its size.
     */
    private stillFits;
    /** True when the cut would leave every card the room it has, or `minSize`. */
    canSplit(id: string, axis: Axis): boolean;
    /**
     * Cut one card in two.
     *
     * The original keeps its id and the near half; the new card takes the far
     * half. Cards spanning the new line widen their span instead of being cut.
     *
     * The new card gets no `data` unless `init.data` is given. A px size on the
     * other axis is copied, since both halves stay in that slot. A px size on the
     * cut axis is divided between them.
     *
     * Returns the new card's id, or null when there is no room.
     */
    split(id: string, axis: Axis, init?: {
        id?: string;
        data?: unknown;
    }): string | null;
    /**
     * Cut a card and put the new one on a named side.
     *
     * `split` gives the far half to the new card, so `left` and `top` swap the
     * two spans. Ids are not swapped.
     */
    splitToward(id: string, side: Side, init?: {
        id?: string;
        data?: unknown;
    }): string | null;
    private nextId;
    /**
     * Which neighbours would grow over a card if it closed, as frozen copies.
     *
     * `null` when no row of neighbours matches a side, which is when `close`
     * removes the card's slots instead.
     */
    fill(id: string): Fill | null;
    /** The same, holding the cards themselves, so `close` can grow them. */
    private fillOf;
    /**
     * The axis on which this card's slots hold no other card, or null.
     *
     * On that axis the slots can be removed when the card closes, without a
     * neighbour growing over it. Returns null when another card lies entirely
     * inside the range, which would leave it spanning nothing.
     */
    private soleSlots;
    private removable;
    canClose(id: string): boolean;
    /**
     * Remove a card.
     *
     * A row of neighbours grows over the space when one matches the side.
     * Otherwise the card's slots are removed. Returns false when neither
     * applies, or when the card is `fixed`, or when it is the last one.
     */
    close(id: string): boolean;
    /**
     * Whether a card reaching across the plane can stand on this boundary.
     *
     * True when no card spans over the line. `without` ignores one card by id.
     */
    canInsertAt(axis: Axis, line: number, without?: string): boolean;
    /**
     * Put a card at a boundary, reaching across the whole plane.
     *
     * Unlike `splitToward`, the new card spans the whole plane on the other axis.
     * Cards past the boundary shift by one index.
     *
     * `size` is required, in px, and must be less than the plane. It becomes a
     * span taken from the whole plane in proportion.
     *
     * Returns the new card's id, or null when a card spans the boundary, the size
     * is invalid, or the result would leave a card without area.
     */
    insertAt(axis: Axis, line: number, init: {
        id?: string;
        data?: unknown;
        size: number;
    }): string | null;
    /** Whether a card occupies one slot and reaches across everything else. */
    private spansPlane;
    /**
     * Insert a slot at a boundary with the given span.
     *
     * Every other slot is scaled by `1 - span`. A card ending at the boundary
     * keeps its index; a card starting there shifts by one.
     */
    private openSlot;
    /**
     * Open a slot at a boundary and shift the spans that referenced it.
     *
     * A card that starts on the line moves past the new slot; one that ends on it
     * stays where it ends. This is what `removeLine(axis, line, 'hi')` undoes.
     */
    private openIndex;
    /**
     * Remove one line and shift the spans that referenced it.
     *
     * `into` says which neighbouring slot absorbs the one that goes, which
     * decides whether a card ending on the line follows it or reaches past it.
     */
    private removeLine;
    /**
     * Remove one slot by removing a line beside it.
     *
     * The far line, or the near one for the last slot, so the plane's two borders
     * are never removed.
     */
    private dropSlot;
    /**
     * Move a plane-spanning card to another boundary.
     *
     * Its slot is removed and a slot of the same span is inserted at the target.
     * No other card's spans change and no line on the other axis moves.
     *
     * `line` is an index in the current arrangement.
     */
    moveTo(id: string, axis: Axis, line: number): boolean;
    /**
     * Every boundary a plane-spanning card could stand on.
     *
     * `without` ignores one card by id, so a card already standing somewhere can
     * ask where else it could stand without blocking itself.
     */
    standings(axis: Axis, without?: string): number[];
    /**
     * Move a card to sit on one side of another — the drag-and-drop operation.
     *
     * One operation rather than a close and a split the caller sequences, because
     * the order matters: closing first gives the space back and changes the
     * target's geometry, so the cut is measured after that, and a close that
     * cannot happen leaves the whole move undone rather than half of it.
     *
     * The card keeps its id and its payload, so the host's element is reused and
     * a live surface inside it is not torn down. It keeps its px size only when it
     * lands spanning one slot on that axis.
     */
    move(id: string, targetId: string, side: Side): boolean;
    /** Whether `move` would succeed, without performing it. */
    canMove(id: string, targetId: string, side: Side): boolean;
    /**
     * What every operation does when it is finished.
     *
     * A px size describes one slot. A card that comes to span two cannot be that
     * size, so the number is removed rather than kept for a later split to apply.
     */
    private changed;
    /**
     * Make every card in a slot declare the same px size, the largest asked for,
     * and drop a size from a card that no longer stands in one slot.
     *
     * A slot has one width, so two cards in it cannot ask for different ones.
     * `heldSizes` reads the largest, and this writes that back, so what `toJSON`
     * reports is what gets drawn. Run it wherever cards arrive or move.
     */
    private agreeSizes;
    /** Put the arrangement back to a state it reported earlier. */
    private restore;
}
