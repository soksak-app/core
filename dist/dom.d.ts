/**
 * DOM binding for `Soksak`.
 *
 * The view owns position, lifecycle and pointer input. It does not own markup:
 * pane elements come from a `createPane` callback the host supplies, and the
 * elements the view must create itself (dividers and boundary rules) carry only
 * a class name and data attributes, with no visual styling. Everything you can
 * see is the host's CSS.
 *
 * The host element needs `position: relative` (or any non-static position); the
 * view places children absolutely inside it.
 */
import { Soksak } from './soksak.js';
import type { Pane, Rect } from './soksak.js';
export type ChangeReason = 'drag' | 'center' | 'merge' | 'resize' | 'render';
export interface ViewOptions {
    /**
     * Build the element for a pane. Called once per pane; the returned element is
     * reused across renders, so a live surface inside it survives splits, closes
     * and drags. The view sets only `position`, `left`, `top`, `width`, `height`.
     */
    createPane(pane: Pane): HTMLElement;
    /** Called on every render for every pane, after the rect is applied. */
    updatePane?(el: HTMLElement, pane: Pane, rect: Rect): void;
    /** Called when a pane element is about to be removed. */
    destroyPane?(el: HTMLElement, pane: Pane): void;
    /** Class name stem for the elements the view creates. Default `sp`. */
    classPrefix?: string;
    /** Draw the boundary lines. Set false to draw them yourself from `grid.rules()`. Default true. */
    rules?: boolean;
    /** Fired after any interaction the view handled, and after `render()`. */
    onChange?(reason: ChangeReason): void;
    /** Keep the plane size in sync with the host element. Default true. */
    observeResize?: boolean;
}
export declare class SoksakView {
    private host;
    private grid;
    private options;
    private prefix;
    private paneEls;
    private dividerEls;
    private ruleEls;
    private drag;
    private observer;
    private disposed;
    constructor(host: HTMLElement, grid: Soksak, options: ViewOptions);
    /** Re-place every element from the grid. Cheap enough to call on every frame of a drag. */
    render(reason?: ChangeReason): void;
    private sweep;
    /**
     * Dividers are reused across renders. Rebuilding one mid-drag would drop its
     * pointer capture, which reads as the boundary jumping once and then going dead.
     */
    private makeDivider;
    /** The element currently showing a pane, if any. */
    element(id: string): HTMLElement | undefined;
    destroy(): void;
}
