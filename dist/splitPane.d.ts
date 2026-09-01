/**
 * A soksak over shared grid lines.
 *
 * Two arrays of numbers own every coordinate. A card is a span of indices into
 * them, so two cards that meet read the same index: a boundary is one number and
 * cannot drift apart. Moving a line moves every card that reads it; a card that
 * spans *across* the line is untouched, and for it the line is virtual —
 * invisible as a boundary, still there, and a later split snaps to it.
 *
 * Everything on the plane is a card. A sidebar at the window's edge is a card
 * holding the first column at a fixed width; the same card holding a middle
 * column is a rail standing between panes. Nothing can cross either, because a
 * card occupies its columns — the structure is the guarantee, so there is no
 * line to check and no tolerance to tune.
 *
 * Splitting only ever replaces one card with two, so the arrangement is always
 * slicing and every card stays closable. See `slicing.ts` for why that matters.
 */
import type { Axis, Card, CardInit, Rect, Side } from './card.js';
import type { ZoneHit, ZoneOptions } from './geometry.js';
export type { Zone, ZoneHit, ZoneOptions } from './geometry.js';
import type { Fill, FillOrder, Span } from './slicing.js';
export type { Axis, Card, CardInit, Rect, Side } from './card.js';
export type { Fill, FillOrder } from './slicing.js';
/** `merge`: a dragged boundary snaps onto a neighbouring line and the two become one. */
export type SnapMode = 'merge' | 'off';
export interface SoksakState {
    xs: number[];
    ys: number[];
    cards: CardInit[];
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
 * A place to grab a boundary. Only where cards actually break on it — elsewhere
 * a card spans across and there is nothing between two things to take hold of.
 */
export interface Divider extends Rect {
    key: string;
    axis: Axis;
    line: number;
    /**
     * The card whose fixed size this drag changes, if any.
     *
     * A boundary beside a card that holds its slot at a fixed size resizes that
     * card; anywhere else it moves the line and the cards on both sides follow.
     * One gesture, and what it does is a fact about what is next to it.
     */
    resizes?: string;
}
/**
 * A boundary to draw. Every line yields one `virtual: true` rule spanning the
 * whole plane plus one solid rule per stretch where cards actually break on it.
 */
export interface Rule extends Rect {
    key: string;
    axis: Axis;
    line: number;
    virtual: boolean;
}
export declare class Soksak {
    private xs;
    private ys;
    private list;
    private w;
    private h;
    private seq;
    private sliceMemo;
    gap: number;
    minSize: number;
    grabSize: number;
    snapDistance: number;
    snap: SnapMode;
    fillOrder: FillOrder;
    /** Without a state, starts as one card filling the plane. */
    constructor(state?: SoksakState, options?: SoksakOptions);
    static from(state: SoksakState, options?: SoksakOptions): Soksak;
    resize(width: number, height: number): void;
    get width(): number;
    get height(): number;
    get cards(): readonly Card[];
    card(id: string): Card | undefined;
    /** Grid line coordinates, normalised 0..1. A copy — the arrangement owns them. */
    lines(axis: Axis): number[];
    toJSON(): SoksakState;
    private get plane();
    private arr;
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
    /** Cards that span across a line. They are what a card placed on it would cut. */
    cardsCrossing(axis: Axis, line: number): Card[];
    /** How many lines a card spans across — how much finer its neighbours are. */
    crossings(card: Card): number;
    /** True when no card reads this line — it survives only as a snap target. */
    isVirtual(axis: Axis, line: number): boolean;
    virtualCount(): number;
    isSlicing(list?: readonly Span[]): boolean;
    /** Everything to draw: one virtual rule per line, plus its solid stretches. */
    rules(): Rule[];
    /**
     * The card a boundary resizes, if the slot on either side is held at a fixed
     * size. The card before it answers first, so dragging a sidebar's inner edge
     * resizes the sidebar rather than the pane beside it.
     */
    private holderAt;
    dividers(): Divider[];
    /** Where a boundary is now, in px along its axis. */
    boundaryPos(axis: Axis, line: number): number;
    /** How far a boundary may travel before some card would fall under `minSize`. */
    boundaryRange(axis: Axis, line: number): [number, number];
    private inset;
    /**
     * Move a boundary to a position in px.
     *
     * What that means is a fact about what is beside it: next to a card holding
     * its slot at a fixed size it changes that size, and anywhere else it moves
     * the line, which every card reading it follows. One gesture either way.
     *
     * Returns where the boundary ended up.
     */
    moveBoundary(axis: Axis, line: number, px: number, allowSnap?: boolean): number;
    /** How many px the sharing slots have between them, per unit of normalised span. */
    private sharedExtent;
    /**
     * Put a boundary where the two cards beside it come out the same size.
     *
     * Not the midpoint of the two lines — a card at the plane's border carries the
     * corridor inset on one side only, so centring the line leaves it half a
     * corridor wider than its neighbour.
     */
    centerBoundary(axis: Axis, line: number): number;
    /**
     * Fold a line onto a neighbour it now coincides with.
     *
     * Refused when a card spans the pair — that card would be left with no size,
     * and `minSize` keeps the state from arising in the first place.
     */
    mergeCoincident(axis: Axis, line: number): boolean;
    /** Drop lines no card reads any more. Returns how many went. */
    tidy(): number;
    /**
     * Where to cut.
     *
     * Among the virtual lines the card spans, the one nearest its centre that
     * leaves both halves at least `minSize`; otherwise a new line at the centre,
     * pulled inside the range that fits. A single off-centre virtual line must
     * never lock a card that has room.
     */
    private cutAt;
    /** True when both halves would keep `minSize`. */
    canSplit(id: string, axis: Axis): boolean;
    /**
     * Cut one card in two.
     *
     * The original keeps its identity and its near half, so a live surface it owns
     * survives; the new card takes the far half. Cards that span the new line only
     * widen their span — they are not cut.
     *
     * The new card carries no `data` unless you give it some. A host that hangs a
     * payload on its cards has to answer for the new one, and copying the source's
     * would hand two cards one surface. A fixed size on the *other* axis rides
     * along, because both halves still stand in that slot.
     *
     * Returns the new card's id, or null when there was no room.
     */
    split(id: string, axis: Axis, init?: {
        id?: string;
        data?: unknown;
    }): string | null;
    /**
     * Cut a card and put the new one on a named side.
     *
     * `split` always hands the far half to the new card, so `left` and `top` have
     * the two exchange the halves they hold. What is exchanged is the *span* — a
     * card's identity stays with the card, because a host that is holding one and
     * finds its id changed underneath has no way to notice.
     */
    splitToward(id: string, side: Side, init?: {
        id?: string;
        data?: unknown;
    }): string | null;
    private nextId;
    fill(id: string): Fill | null;
    canClose(id: string): boolean;
    /** Remove a card; its neighbours grow into the space. */
    close(id: string): boolean;
    /**
     * Whether a card reaching across the whole plane can stand on this boundary.
     *
     * It can when no card spans over it. That is a fact about the spans — integers
     * — not a comparison of coordinates, so there is no tolerance to tune and
     * nothing to repair afterwards. Dragging a boundary can never change the
     * answer; only splitting and closing can.
     */
    canInsertAt(axis: Axis, line: number): boolean;
    /**
     * Put a card at a boundary, reaching across the whole plane.
     *
     * This is the operation `splitToward` is not. Splitting cuts one card, so the
     * new one inherits that card's extent — a rail made that way would stand in
     * one row and be a pane like any other. A card that separates everything from
     * everything has to be inserted at a boundary nothing crosses, and every card
     * past it moves along.
     *
     * Returns the new card's id, or null when a card spans the boundary.
     */
    insertAt(axis: Axis, line: number, init?: {
        id?: string;
        data?: unknown;
        size?: number;
    }): string | null;
    /** Whether a card occupies one slot and reaches across everything else. */
    private spansPlane;
    /**
     * Open a slot at a boundary.
     *
     * The coordinate is duplicated, so the new slot has no share of its own and
     * takes its size from the card that will hold it. A card that *ends* at the
     * boundary keeps ending there — the slot opens after it — while one that
     * starts there moves along. Getting that asymmetry wrong is how a card ends up
     * spanning the slot it was supposed to make room for.
     */
    private openSlot;
    /** Take a slot out of the axis. The cards on either side meet where it was. */
    private dropSlot;
    /**
     * Take a plane-spanning card to another boundary.
     *
     * Its column leaves and a column arrives — nothing is closed and nothing is
     * split, so no other card's spans change and no boundary on the other axis
     * moves at all. Travelling that way is the difference between a rail moving
     * and a layout being rearranged around it.
     *
     * `line` is a boundary in the arrangement as it stands now.
     */
    moveTo(id: string, axis: Axis, line: number): boolean;
    /** Every boundary a plane-spanning card could stand on. */
    standings(axis: Axis): number[];
    /**
     * Move a card to sit on one side of another — the drag-and-drop operation.
     *
     * One operation rather than a close and a split the caller sequences, because
     * the order matters: closing first gives the space back and changes the
     * target's geometry, so the cut is measured after that, and a close that
     * cannot happen leaves the whole move undone rather than half of it.
     *
     * The card keeps its id, its payload and its fixed size, so a live surface
     * rides along and a sidebar stays the width it was.
     */
    move(id: string, targetId: string, side: Side): boolean;
    /** Whether `move` would succeed, without performing it. */
    canMove(id: string, targetId: string, side: Side): boolean;
    /** Put the arrangement back to a state it reported earlier. */
    private restore;
}
