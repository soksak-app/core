/**
 * The only place coordinates are computed.
 *
 * Two arrays of numbers own every position. A card is a span of indices into
 * them, so two cards that meet read the same index and their shared boundary is
 * one number — it cannot drift, and there is no tolerance anywhere that decides
 * whether two places are the same place.
 *
 * Every function here is pure. The arrangement holds the state and asks.
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
}
/**
 * The px width of every slot along an axis.
 *
 * A slot a card holds at a fixed size contributes that size; the rest share what
 * is left, in the proportions the lines describe. Walking the slots in order is
 * what makes a card at the plane's edge and one standing between panes the same
 * case — the only difference is which slot it holds.
 */
export declare function slotSizes(plane: Plane, axis: Axis): number[];
/** Where a grid line falls in px — the sum of every slot before it. */
export declare function linePos(plane: Plane, axis: Axis, index: number): number;
/** Every line position in px, index for index with the line array. */
export declare function linePositions(plane: Plane, axis: Axis): number[];
/**
 * How far a card's edge pulls back from the line it sits on.
 *
 * Half a corridor on every side that faces another card, and nothing at the
 * plane's own border. One rule, so no card needs a special case.
 */
export declare function inset(plane: Plane, axis: Axis, index: number, side: 'lo' | 'hi'): number;
/** Where a card's edge falls in px. */
export declare function edgePos(plane: Plane, axis: Axis, index: number, side: 'lo' | 'hi'): number;
/** The rect of one card. Every rect in the library comes from here. */
export declare function rectOf(plane: Plane, card: Card): Rect;
/** Cards that span across a line. They are why a card cannot be placed on it. */
export declare function crossing(plane: Plane, axis: Axis, line: number): Card[];
/**
 * Index stretches where cards actually break on a line.
 *
 * A line runs the whole plane, but it is only a boundary where one card ends and
 * another begins. Everywhere else a card spans across it, and there is nothing
 * there to grab or to draw solid.
 */
export declare function boundarySpans(plane: Plane, axis: Axis, line: number): [number, number][];
/** Whether any card reads this line at all. One that none reads is only a memory of a boundary. */
export declare function isVirtual(plane: Plane, axis: Axis, line: number): boolean;
/** The interior lines of an axis — the plane's own two borders are not boundaries. */
export declare function interiorLines(plane: Plane, axis: Axis): number[];
/** A boundary to draw. One virtual rule per line, plus its solid stretches. */
export interface Rule extends Rect {
    key: string;
    axis: Axis;
    line: number;
    virtual: boolean;
}
/** A place to grab a boundary, and what dragging it changes. */
export interface Divider extends Rect {
    key: string;
    axis: Axis;
    line: number;
    /** The card whose fixed size this drag changes, if any. */
    resizes?: string;
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
 * Where a boundary can be grabbed, and which card a drag there resizes.
 *
 * Only where cards break on the line — elsewhere a card spans across it and
 * there is nothing between two things to take hold of. The grab area is kept
 * apart from the corridor so a zero gap is still grabbable.
 */
export declare function dividers(plane: Plane, grabSize: number, holder: (axis: Axis, line: number) => string | undefined): Divider[];
/**
 * Where a drop lands: which card, and which part of it.
 *
 * `centre` means the card itself — join what is already there. A side means the
 * drop needs a new place beside it, and which side is which edge the point is
 * nearest, measured on the body rather than the whole card, so a header or a
 * status bar cannot read as "the top".
 *
 * The band is a fraction of the body, not px, so a small card and a large one
 * feel the same to aim at.
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
/** Every axis a card is measured on, for a caller that treats both alike. */
export declare const axes: readonly Axis[];
