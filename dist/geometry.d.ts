/**
 * Coordinate computation.
 *
 * `xs` and `ys` hold every position, normalised 0..1 over the slots that share
 * the remaining space. A slot with a px size is drawn at that size whatever its
 * span, so a line's px position is not its value times the plane size. A card is
 * a span of indices into them, so two cards that meet reference the same index.
 *
 * Every function here is pure and takes the plane as an argument.
 */
import type { Axis, Card, Rect, Side } from './card.js';
/** Everything a coordinate depends on. */
export interface Plane {
    xs: number[];
    ys: number[];
    cards: readonly Card[];
    width: number;
    height: number;
    /** Gap between two cards, in px. Half of it insets every inner edge. */
    gap: number;
    /** Minimum card size, in px. */
    minSize: number;
}
/**
 * The gap a slot holds: half a gap for every card edge that insets into it.
 *
 * Lines at one position form one boundary, and a zero-width slot cannot hold a
 * gap, so the cost falls on the nearest slot that can. Two lines of a run can
 * each place an edge here, and one half gap covers both, so the run takes the
 * largest value rather than the sum.
 */
export declare function corridorOf(plane: Plane, axis: Axis, slot: number, read?: Set<number>): number;
/** The px size each slot declares: the largest value any card in it sets. */
export declare function heldSizes(plane: Plane, axis: Axis): (number | null)[];
/** Drawn width of every slot, gap removed. */
export declare function slotWidths(plane: Plane, axis: Axis): number[];
/**
 * Width in px of every slot on an axis.
 *
 * A slot with a px size takes that size; the rest divide the remainder in
 * proportion to their spans, down to `minSize` each.
 *
 * When the px sizes do not fit, they are scaled by one factor so the slots still
 * sum to the plane size.
 */
export declare function slotSizes(plane: Plane, axis: Axis): number[];
/** Every line position in px, index for index with the line array. */
export declare function linePositions(plane: Plane, axis: Axis): number[];
/**
 * How far a card's edge insets from the line it references.
 *
 * `read` is the set of lines any card references. Computing it costs one pass
 * over the cards, so a caller that needs many lines computes it once and passes
 * it in. Without that, a loop over N cards scans the cards N times.
 */
export declare function inset(plane: Plane, axis: Axis, index: number, side: 'lo' | 'hi', read?: Set<number>): number;
/** Half the gap a referenced line takes, capped at what the plane can hold. */
export declare function halfCorridor(plane: Plane, axis: Axis, read?: Set<number>): number;
/** The lines any card references. One pass over the cards. */
export declare function linesReadOn(plane: Plane, axis: Axis): Set<number>;
/** Line positions and edge insets for one axis. */
export interface Axle {
    at: number[];
    /** How far a card starting at each line insets from it. */
    lo: number[];
    /** How far a card ending at each line insets from it. */
    hi: number[];
}
/** Frames for both axes. */
export interface Frame {
    x: Axle;
    y: Axle;
}
/**
 * Line positions and edge insets for both axes.
 *
 * Computed once and passed to `rectIn`, so placing N cards is O(N) rather than
 * O(N squared).
 */
export declare function frameOf(plane: Plane): Frame;
/** Rect of one card from a precomputed frame. */
export declare function rectIn(frame: Frame, card: Card): Rect;
/** The rect of one card. Every rect in the library is computed here. */
export declare function rectOf(plane: Plane, card: Card): Rect;
/** Cards that span across a line. Their presence blocks placement on it. */
export declare function crossing(plane: Plane, axis: Axis, line: number): Card[];
/**
 * Cards indexed by the line they end at and the line they start at.
 *
 * Built once per axis so `boundarySpans` pairs only the cards that meet at a
 * line rather than every card with every other card.
 */
export interface Touching {
    ends: Map<number, Card[]>;
    starts: Map<number, Card[]>;
}
export declare function touching(plane: Plane, axis: Axis): Touching;
/**
 * Index stretches where cards actually break on a line.
 *
 * A line runs the whole plane but is a boundary only where one card ends and
 * another begins. Elsewhere a card spans across it, so there is nothing to drag
 * and nothing to draw solid.
 */
export declare function boundarySpans(plane: Plane, axis: Axis, line: number, meet?: Touching): [number, number][];
/** True when no card references this line. */
export declare function isVirtual(plane: Plane, axis: Axis, line: number, read?: Set<number>): boolean;
/** Interior line indices. The two borders are excluded. */
export declare function interiorLines(plane: Plane, axis: Axis): number[];
/** A boundary to draw. One virtual rule per line, plus its solid stretches. */
export interface Rule extends Rect {
    key: string;
    axis: Axis;
    line: number;
    virtual: boolean;
}
/** Hit area for dragging a boundary. */
export interface Divider extends Rect {
    key: string;
    axis: Axis;
    line: number;
}
/**
 * The rules to draw for every boundary.
 *
 * A line runs the whole plane, so it produces one rule of that length. It is a
 * boundary only where cards break on it, so each of those stretches produces a
 * solid rule. Draw the first faintly and the second at full strength.
 */
export declare function rules(plane: Plane): Rule[];
/**
 * The draggable area of a boundary.
 *
 * Only where cards break on the line. Elsewhere a card spans across it and there
 * is nothing to drag. The hit area is independent of the gap so a zero gap is
 * still draggable.
 */
export declare function dividers(plane: Plane, grabSize: number): Divider[];
/**
 * Where a drop lands: which card, and which part of it.
 *
 * `centre` means the card itself: join the existing card. A side means a new
 * place beside it, and the side is the nearest edge, measured on the body rather
 * than the whole card so a header or status bar is not treated as the top edge.
 *
 * The band is a fraction of the body rather than px, so the target is the same
 * proportion on a small card and a large one.
 */
export type Zone = 'centre' | Side;
export interface ZoneHit {
    id: string;
    zone: Zone;
}
export interface ZoneOptions {
    /** Fixed chrome at the top of a card, excluded from the drop sides. */
    headerPx?: number;
    /** Fixed chrome at the bottom. */
    footerPx?: number;
    /** How much of the body each edge claims, as a fraction. Default 0.25. */
    edge?: number;
    /** A card that always returns `centre`, used when dragging a card onto itself. */
    centreOnly?: string;
}
export declare function zoneAt(plane: Plane, x: number, y: number, options?: ZoneOptions): ZoneHit | null;
