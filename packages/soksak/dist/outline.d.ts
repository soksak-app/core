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
    /**
     * Corner radius. Default `pad`, i.e. flush with a square pane.
     *
     * One value for every corner. At each corner the stroke runs around a card's
     * corner at the same distance; the turn direction indicates which side the
     * card is on. Two different radii would render as two shapes.
     *
     * For a stroke that stays `pad` outside cards of radius `r`, this is `r + pad`.
     */
    radius?: number;
    /**
     * How far the joined loops move inward after the union. Default 0.
     *
     * A stroke is centered on its path, so a path at the half corridor puts half
     * the stroke past it. Insetting by half the stroke width keeps the stroke
     * inside the half corridor, on whole device pixels when the half corridor
     * lies on a pixel boundary. The join is decided by `pad` first, so an inset
     * never splits a joined outline.
     */
    inset?: number;
}
export interface Outline {
    /** SVG path data for every loop, usable for both `fill` (evenodd) and `stroke`. */
    path: string;
    /** Closed rectilinear loops before rounding. One loop per connected region. */
    loops: Point[][];
    /** Total corner count and the number too tight to round. */
    corners: number;
    sharp: number;
}
/** Boundary of the union of axis-aligned rects, as closed rectilinear loops. */
export declare function unionLoops(rects: readonly Rect[]): Point[][];
/**
 * Converts one closed loop to an SVG path, replacing each right angle with an arc.
 *
 * The radius is capped at half the shorter of the two sides meeting at the
 * corner, so an arc cannot extend past a side's end. A corner with less than
 * half a px left is drawn square and counted in `sharp`.
 */
export declare function roundedPath(loop: readonly Point[], radius: number): {
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
