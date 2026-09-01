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
     * Returns the new pane's id, or null when there was no room.
     */
    split(id: string, axis: Axis, newId?: string): string | null;
    private nextId;
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
