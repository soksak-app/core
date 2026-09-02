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
    /** The smallest a card is asked to be, in px. */
    minSize: number;
}
/**
 * The px width of every slot along an axis.
 *
 * The plane is covered exactly, always. A slot a card holds at a px size takes
 * that size and the rest share what is left — the whole story while there is
 * something left to share.
 *
 * When there is not — every slot held, or the plane narrower than what was
 * asked for — the px sizes scale together to cover it. A card that closes has
 * to send its room somewhere, and a sidebar narrowing with the window is the
 * same fact from the other side: a px size is what a card gets when the plane
 * can give it, not a claim on room the plane does not have.
 */
export declare function slotSizes(plane: Plane, axis: Axis): number[];
/** Where a grid line falls in px — the sum of every slot before it. */
export declare function linePos(plane: Plane, axis: Axis, index: number): number;
/** Every line position in px, index for index with the line array. */
export declare function linePositions(plane: Plane, axis: Axis): number[];
export declare function inset(plane: Plane, axis: Axis, index: number, side: 'lo' | 'hi'): number;
/** Where a card's edge falls in px. */
export declare function edgePos(plane: Plane, axis: Axis, index: number, side: 'lo' | 'hi'): number;
/** Where every line sits and how far each edge pulls back from it, on one axis. */
export interface Axle {
    at: number[];
    half: number[];
}
/** Both axes, measured once. */
export interface Frame {
    x: Axle;
    y: Axle;
}
/**
 * Measure the plane once.
 *
 * `rectOf` asks for four edges, each of which asks where a line is, which walks
 * every slot, which walks every card. One rect was O(cards); a rect for every
 * card was O(cards squared) — 1,000 cards took 89ms to place. The answer is the
 * same for every card, so it is worked out once and handed round.
 */
export declare function frameOf(plane: Plane): Frame;
/** The rect of one card, from a plane already measured. */
export declare function rectIn(frame: Frame, card: Card): Rect;
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
/**
 * The cards that end at each line and the cards that start at each line.
 *
 * Pairing every card with every card to find the pairs that meet at one line
 * was O(cards squared) per line — a thousand cards took 243ms just to place the
 * grab areas. The pairs that meet are known after one pass.
 */
export interface Touching {
    ends: Map<number, Card[]>;
    starts: Map<number, Card[]>;
}
export declare function touching(plane: Plane, axis: Axis): Touching;
export declare function boundarySpans(plane: Plane, axis: Axis, line: number, meet?: Touching): [number, number][];
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
/** A place to grab a boundary. */
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
