/**
 * Pane layout over shared grid lines.
 *
 * There is no tree and no grouping. Two arrays of numbers own every coordinate:
 *
 *   xs   vertical grid lines, normalised 0..1
 *   ys   horizontal grid lines, normalised 0..1
 *
 * A pane is a span of indices into those arrays. Two panes that meet read the
 * same index, so a boundary is one number and cannot drift apart. Moving a line
 * moves every pane that references it; a pane that spans across the line is not
 * affected — for it the line is *virtual*, and a later split snaps to it.
 *
 * Splitting only ever replaces one pane with two, so the layout is always a
 * slicing (guillotine) floorplan. Closing preserves that property, which is what
 * keeps every pane closable: in a slicing floorplan a pane's sibling region
 * always tiles one of its sides exactly.
 */
export type Axis = 'x' | 'y';
/** Which side of a pane something goes on. `left`/`top` land ahead of it. */
export type Side = 'left' | 'right' | 'top' | 'bottom';
/** `merge`: a dragged line snaps to a neighbour and the two become one line. */
export type SnapMode = 'merge' | 'off';
/** Which axis a close tries first when filling the freed space. */
export type FillOrder = 'v' | 'h';
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface PaneInit {
    id: string;
    /** Column span over `xs`. `c0 < c1`. */
    c0: number;
    c1: number;
    /** Row span over `ys`. `r0 < r1`. */
    r0: number;
    r1: number;
    /** A fixed pane is never split, never closed, and never fills a neighbour. */
    fixed?: boolean;
    /** Anything the host wants to carry along. Never read by this library. */
    data?: unknown;
}
export interface Pane extends PaneInit {
    fixed: boolean;
}
export interface SoksakState {
    xs: number[];
    ys: number[];
    panes: PaneInit[];
}
export interface SoksakOptions {
    /** Corridor between panes, in px. Half of it is the outer margin. Default 24. */
    gap?: number;
    /** Smallest pane edge, in px. Splitting and dragging both respect it. Default 96. */
    minSize?: number;
    /** Smallest grab area, in px. Kept independent of `gap` so a zero gap is still grabbable. Default 11. */
    grabSize?: number;
    /** How close a dragged line must come to a neighbour to snap onto it, in px. Default 7. */
    snapDistance?: number;
    snap?: SnapMode;
    fillOrder?: FillOrder;
    width?: number;
    height?: number;
}
/** A grab area. Exists only where the line is a real boundary. */
export interface Divider extends Rect {
    key: string;
    axis: Axis;
    line: number;
}
/**
 * A drawn boundary. Every line yields one `virtual: true` rule spanning the whole
 * plane plus one `virtual: false` rule per stretch where panes actually break on it.
 * Draw the virtual one faintly and the real ones solid.
 */
export interface Rule extends Rect {
    key: string;
    axis: Axis;
    line: number;
    virtual: boolean;
}
/**
 * A fixed-width band standing on a grid line, taking room from the panes.
 *
 * It may only stand on a *clean* line — one no pane spans across — because a
 * pane that crossed it would be cut in two by the band. `cleanLines` reports
 * which lines qualify and `nearestCleanLine` finds the closest one.
 */
export interface Station {
    axis: Axis;
    line: number;
    /** Total room the band takes, in px. Its drawn rect is inset by half a corridor, like a pane. */
    size: number;
}
/** Which neighbours would take over a pane's space, and from which side. */
export interface Fill {
    side: 'below' | 'above' | 'right' | 'left';
    panes: Pane[];
}
type Span = {
    c0: number;
    c1: number;
    r0: number;
    r1: number;
};
export declare class Soksak {
    private xs;
    private ys;
    private list;
    private w;
    private h;
    private seq;
    private sliceMemo;
    private stationAt;
    gap: number;
    minSize: number;
    grabSize: number;
    snapDistance: number;
    snap: SnapMode;
    fillOrder: FillOrder;
    /** Without a state, starts as a single pane filling the plane. */
    constructor(state?: SoksakState, options?: SoksakOptions);
    resize(width: number, height: number): void;
    get width(): number;
    get height(): number;
    get panes(): readonly Pane[];
    pane(id: string): Pane | undefined;
    /** Grid line coordinates, normalised 0..1. Read-only copies. */
    lines(axis: Axis): number[];
    toJSON(): SoksakState;
    static from(state: SoksakState, options?: SoksakOptions): Soksak;
    private arr;
    private size;
    /** Room left for the panes once a band on this axis has taken its own. */
    private usable;
    /**
     * Where a grid line falls in px. Lines at or past the band are pushed along by
     * its width, so the panes on either side of it keep their own proportions.
     */
    private pos;
    private get half();
    /**
     * An interior pane edge is pulled back by half a corridor; an edge sitting on
     * the plane boundary is flush. Every rect in the library measures from here.
     */
    private edge;
    private inset;
    rectOf(pane: Pane): Rect;
    rect(id: string): Rect | undefined;
    rects(): Map<string, Rect>;
    private static merge;
    /** Index stretches where panes actually break on this line. */
    realSpans(axis: Axis, line: number): [number, number][];
    /** True when no pane references the line at all — it survives only as a snap target. */
    isVirtual(axis: Axis, line: number): boolean;
    /**
     * Panes that span across this line. They are what makes it unclean: a band
     * standing here would cut them, and a pane cannot be in two places.
     */
    panesCrossing(axis: Axis, line: number): Pane[];
    /**
     * A line is clean when it is a boundary over the whole plane — no pane spans
     * across it. This is a structural fact about the spans, not a comparison of
     * coordinates, so there is no tolerance to get wrong and no drift to heal.
     */
    isCleanLine(axis: Axis, line: number): boolean;
    /** Every clean line, in order. The plane's own two edges are always clean. */
    cleanLines(axis: Axis): number[];
    /** The clean line nearest a normalised position. Ties go to the earlier line. */
    nearestCleanLine(axis: Axis, value: number): number | null;
    get station(): Station | null;
    /** Stand a band on a clean line. Refuses an unclean one — see `nearestCleanLine`. */
    setStation(axis: Axis, line: number, size: number): boolean;
    clearStation(): void;
    /** The band's drawn rect, inset by half a corridor on each side exactly like a pane. */
    stationRect(): Rect | null;
    /** How many lines a pane spans across. Tells you how much finer its neighbours are. */
    crossings(pane: Pane): number;
    /** Every boundary to draw: one full-plane virtual rule per line, plus its real stretches. */
    rules(): Rule[];
    /** Grab areas. Only where a corridor exists — a virtual stretch has nothing to grab. */
    dividers(): Divider[];
    /** How far a line may travel before some pane hits `minSize`. */
    lineRange(axis: Axis, line: number): [number, number];
    /**
     * Move one line. Every pane that reads it follows; panes that span across it do
     * not. A line may travel all the way onto its neighbour — panes that span the
     * pair stop it at `minSize` first, so nothing is ever squeezed flat.
     */
    moveLine(axis: Axis, line: number, value: number, allowSnap?: boolean): number;
    /**
     * Put a line where the two panes beside it come out the same size. Not the
     * midpoint of the line coordinates — a pane on the plane edge carries the
     * corridor inset on one side only, so centring the line leaves it half a
     * corridor wider.
     */
    centerLine(axis: Axis, line: number): number;
    /**
     * Fold a line onto a neighbour it exactly coincides with. Refuses when a pane
     * spans the pair, which would leave that pane with no size — `minSize` keeps
     * that state from arising in the first place.
     */
    mergeCoincident(axis: Axis, line: number): boolean;
    /**
     * Where to cut. Among the virtual lines the pane spans, take the one nearest
     * its centre that leaves both halves at least `minSize`; otherwise draw a new
     * line at the centre, pulled inside the feasible range. A single off-centre
     * virtual line must never lock a pane that has room.
     */
    private cutAt;
    /** True when both halves would keep `minSize`. Equivalently: edge >= 2·minSize + gap. */
    canSplit(id: string, axis: Axis): boolean;
    /**
     * Cut one pane in two. The original keeps its identity and its near half, so a
     * live surface it owns survives; the new pane takes the far half. Panes that
     * span the new line only widen their span — they are not cut.
     *
     * The new pane carries no `data` unless you give it some. A host that hangs a
     * payload on its panes has to answer for the new one, and guessing on its
     * behalf — copying the source's payload — would hand two panes one surface.
     *
     * Returns the new pane's id, or null when there was no room.
     */
    split(id: string, axis: Axis, init?: {
        id?: string;
        data?: unknown;
    }): string | null;
    private nextId;
    /**
     * Cut a pane and put the new one on a named side.
     *
     * `split` always hands the far half to the new pane. When the new one belongs
     * ahead — on the left or on top — the two swap payloads afterwards, because
     * what a caller means by "put it on the left" is where the content ends up,
     * not which record was created first.
     */
    splitToward(id: string, side: Side, init?: {
        id?: string;
        data?: unknown;
    }): string | null;
    /**
     * Move a pane to sit on one side of another. This is the drag-and-drop
     * operation: the pane leaves where it was, its neighbours take that space,
     * and it arrives beside the target.
     *
     * It is one operation rather than a close and a split the caller sequences,
     * because the order matters — closing first changes the target's geometry, so
     * the split has to be measured after the space is given back, and a close that
     * cannot happen must leave the whole move undone rather than half of it.
     *
     * Returns false and changes nothing when the move cannot be made: the pane is
     * fixed, the target is gone, nothing can fill the space the pane leaves, or
     * the target has no room to be cut.
     */
    move(id: string, targetId: string, side: Side): boolean;
    /** Put the grid back to a state it reported earlier. */
    private restore;
    /** Whether `move` would succeed, without performing it. */
    canMove(id: string, targetId: string, side: Side): boolean;
    /**
     * Splitting only ever replaces one pane with two, so the layout is always a
     * slicing floorplan — a pinwheel cannot be reached. Closing has to keep that
     * property; the moment it breaks, panes appear that no neighbour can fill.
     */
    isSlicing(list?: Span[]): boolean;
    /**
     * Which neighbours would take the freed space. One pane need not match
     * exactly — a row of them may tile the side together — but the result has to
     * be slicing again, which is what keeps every pane closable. In a slicing
     * floorplan such a side always exists.
     */
    fill(id: string): Fill | null;
    canClose(id: string): boolean;
    /** Remove a pane; its neighbours grow into the space. Returns false when nothing can fill it. */
    close(id: string): boolean;
    /** Drop lines no pane references any more. Returns how many went. */
    tidy(): number;
    /** How many lines exist that no pane references. */
    virtualCount(): number;
}
export {};
