/**
 * Rounded outline around a set of rectangles.
 *
 * Panes separated by a corridor do not touch, so their plain union falls apart
 * into one loop per pane. Grow each rect by `pad` first: at `pad >= gap / 2` the
 * grown rects meet on the corridor centre line and the union closes into one
 * shape. That is the whole trick — the outline is derived from the pane borders,
 * pushed outward by exactly the margin every pane already owns.
 *
 * Every right angle is drawn as an arc, convex corners concentric with the pane
 * radius and reflex corners at the pad radius.
 */
import type { Rect } from './soksak.js';
export interface Point {
    x: number;
    y: number;
}
export interface OutlineOptions {
    /** How far outside the rect borders the outline runs. Default 0. */
    pad?: number;
    /** Convex corner radius. Default `pad`, i.e. flush with a square pane. */
    radius?: number;
    /** Reflex (inner) corner radius. Default `max(4, pad)`. */
    innerRadius?: number;
}
export interface Outline {
    /** SVG path data for every loop, ready for both `fill` (evenodd) and `stroke`. */
    path: string;
    /** Closed rectilinear loops, before rounding. One loop means one lump. */
    loops: Point[][];
    /** Total corner count, and how many were too tight to round. */
    corners: number;
    sharp: number;
}
/** Boundary of the union of axis-aligned rects, as closed rectilinear loops. */
export declare function unionLoops(rects: readonly Rect[]): Point[][];
/** One closed loop as an SVG path with every right angle turned into an arc. */
export declare function roundedPath(loop: readonly Point[], radius: number, innerRadius: number): {
    d: string;
    corners: number;
    sharp: number;
};
/**
 * Outline binding a set of rects into one shape.
 *
 * With `pad` at half the corridor the rects meet exactly and you get a single
 * loop; below that they stay apart and you get one loop each, which is a useful
 * signal rather than a failure.
 */
export declare function outline(rects: readonly Rect[], options?: OutlineOptions): Outline;
/** Even-odd point test against a set of loops. */
export declare function contains(loops: readonly Point[][], x: number, y: number): boolean;
