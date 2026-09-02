/**
 * Outline of a set of rects.
 *
 * `outline` returns the path around one or more rects, padded and rounded, as
 * a list of loops and an SVG path string. Adjacent rects give one loop;
 * separated rects give one loop each.
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
/**
 * One closed loop as an SVG path, each right angle turned into an arc.
 *
 * The radius is capped at half the shorter of the two sides meeting at the
 * corner, so a short side cannot bow past its own end. A corner left with less
 * than half a px is cut straight instead and counted in `sharp`.
 */
export declare function roundedPath(loop: readonly Point[], radius: number, innerRadius: number): {
    d: string;
    corners: number;
    sharp: number;
};
/**
 * Outline binding a set of rects into one shape.
 *
 * With `pad` at half the corridor the rects meet exactly and the result is a
 * single loop. Below that they stay apart and the result is one loop each,
 * which reports the separation rather than failing.
 */
export declare function outline(rects: readonly Rect[], options?: OutlineOptions): Outline;
/** Even-odd point test against a set of loops. */
export declare function contains(loops: readonly Point[][], x: number, y: number): boolean;
