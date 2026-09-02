/**
 * Coordinate computation.
 *
 * `xs` and `ys` hold every position, normalised 0..1 over the slots that share
 * what is left; a slot held at a px size is drawn at that size whatever its
 * span, so a line's position in px is not its number times the plane. A card is a
 * span of indices into them, so two cards that meet read the same index.
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
    /** Corridor between two cards, in px. Half of it insets every inner edge. */
    gap: number;
    /** The smallest a card is asked to be, in px. */
    minSize: number;
}
/**
 * Corridor a slot carries: half a gap for every card edge that insets into it.
 *
 * Lines at one position are one boundary, and a blank slot has no width to
 * carry a corridor with, so the charge falls on the nearest slot that has one.
 * Two lines of a run can each land an edge here — a card starting at either —
 * and one half gap holds both, so the run charges the largest, not the sum.
 */
export declare function corridorOf(plane: Plane, axis: Axis, slot: number, read?: Set<number>): number;
/** The px size each slot declares: the largest any card in it asks for. */
export declare function heldSizes(plane: Plane, axis: Axis): (number | null)[];
/** Drawn width of every slot, corridor removed. */
export declare function slotWidths(plane: Plane, axis: Axis): number[];
/**
 * Width in px of every slot on an axis.
 *
 * A slot held at a px size takes that size; the rest divide what is left in
 * proportion to their spans, down to `minSize` each.
 *
 * When the px sizes do not fit, they are scaled by one factor so the slots
 * still sum to the plane.
 */
export declare function slotSizes(plane: Plane, axis: Axis): number[];
/** Every line position in px, index for index with the line array. */
export declare function linePositions(plane: Plane, axis: Axis): number[];
/**
 * How far a card's edge sits back from the line it reads.
 *
 * `read` is which lines any card references. It costs one pass over the cards,
 * so a caller asking about many lines or many cards works it out once and hands
 * it in; without that a loop over N cards walks the cards N times.
 */
export declare function inset(plane: Plane, axis: Axis, index: number, side: 'lo' | 'hi', read?: Set<number>): number;
/** Half the corridor a real line draws, capped at what the plane can hold. */
export declare function halfCorridor(plane: Plane, axis: Axis, read?: Set<number>): number;
/** Which lines any card references. One pass over the cards. */
export declare function linesReadOn(plane: Plane, axis: Axis): Set<number>;
/** Line positions and edge insets for one axis. */
export interface Axle {
    at: number[];
    /** How far a card starting at each line sits back from it. */
    lo: number[];
    /** How far a card ending at each line sits back from it. */
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
/** The rect of one card. Every rect in the library comes from here. */
export declare function rectOf(plane: Plane, card: Card): Rect;
/** Cards that span across a line. They are why a card cannot be placed on it. */
export declare function crossing(plane: Plane, axis: Axis, line: number): Card[];
/**
 * Cards indexed by the line they end at and the line they start at.
 *
 * Built once per axis so `boundarySpans` pairs only the cards that meet at a
 * line, rather than every card with every card.
 */
export interface Touching {
    ends: Map<number, Card[]>;
    starts: Map<number, Card[]>;
}
export declare function touching(plane: Plane, axis: Axis): Touching;
/**
 * Index stretches where cards actually break on a line.
 *
 * A line runs the whole plane, but it is only a boundary where one card ends and
 * another begins. Everywhere else a card spans across it, and there is nothing
 * there to grab or to draw solid.
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
 * Everything to draw for the boundaries.
 *
 * A line runs the whole plane, so it gets one rule that does; it is only a
 * boundary where cards actually break on it, so each of those stretches gets a
 * solid one. Draw the first faintly and the second not.
 */
export declare function rules(plane: Plane): Rule[];
/**
 * Where a boundary can be grabbed.
 *
 * Only where cards break on the line — elsewhere a card spans across it and
 * there is nothing between two things to take hold of. The grab area is kept
 * apart from the corridor so a zero gap is still grabbable.
 */
export declare function dividers(plane: Plane, grabSize: number): Divider[];
/**
 * Where a drop lands: which card, and which part of it.
 *
 * `centre` means the card itself — join what is already there. A side means the
 * drop needs a new place beside it, and which side is which edge the point is
 * nearest, measured on the body rather than the whole card, so a header or a
 * status bar cannot read as "the top".
 *
 * The band is a fraction of the body, not px, so the target is the same
 * proportion of a small card and a large one.
 */
export type Zone = 'centre' | Side;
export interface ZoneHit {
    id: string;
    zone: Zone;
}
export interface ZoneOptions {
    /** Fixed chrome at the top of a card that is never a drop side. */
    headerPx?: number;
    /** Fixed chrome at the bottom. */
    footerPx?: number;
    /** How much of the body each edge claims, as a fraction. Default 0.25. */
    edge?: number;
    /** A card that only ever answers `centre` — dragging a card onto itself. */
    centreOnly?: string;
}
export declare function zoneAt(plane: Plane, x: number, y: number, options?: ZoneOptions): ZoneHit | null;
