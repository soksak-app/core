/**
 * Card types.
 *
 * Every element on the plane is a card: sidebar, rail, and pane use one type.
 * A card occupies a span of slots on each axis.
 *
 * `fixed` sets whether the layout may split, close or move the card.
 * `width` and `height` set how many px a card is drawn at when the plane has
 * the room; otherwise the card takes a share of what is left.
 */
export type Axis = 'x' | 'y';
/** Which side of a card to place on. */
export type Side = 'left' | 'right' | 'top' | 'bottom';
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface CardInit {
    id: string;
    /** Column span over `xs`. `c0 < c1`. */
    c0: number;
    c1: number;
    /** Row span over `ys`. `r0 < r1`. */
    r0: number;
    r1: number;
    /**
     * Width in px, instead of a share of what is left.
     * Applies only to a card spanning one column.
     */
    width?: number;
    /** Height in px, instead of a share of what is left. Spans one row. */
    height?: number;
    /** When true, the layout does not split, close, move or grow this card. */
    fixed?: boolean;
    /** Host payload. This library does not read it. */
    data?: unknown;
}
export interface Card extends CardInit {
    fixed: boolean;
}
/** Span keys for an axis. */
export declare const SPAN: Record<Axis, readonly ['c0' | 'r0', 'c1' | 'r1']>;
/** Span keys for the other axis. */
export declare const AXES: readonly Axis[];
export declare const axisOf: (side: Side) => Axis;
/** True when the side is before the card on its axis. */
export declare const isAhead: (side: Side) => boolean;
/** Number of slots the card spans on an axis. */
export declare const spanOf: (card: Card, axis: Axis) => number;
/** The px size set on an axis, or null when the card takes a share. */
export declare function fixedSize(card: Card, axis: Axis): number | null;
/** The axis that is not this one. */
export declare function other(axis: Axis): Axis;
/** Every side a card can be split toward. */
export declare const SIDES: readonly Side[];
