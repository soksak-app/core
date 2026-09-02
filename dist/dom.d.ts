/**
 * DOM binding for `Soksak`.
 *
 * The view owns position, lifecycle and pointer input. It does not own markup:
 * card elements come from a `createCard` callback the host supplies, and the
 * elements the view must create itself (dividers and boundary rules) carry only
 * a class name and data attributes, with no visual styling. Everything you can
 * see is the host's CSS.
 *
 * The host element needs `position: relative` (or any non-static position); the
 * view places children absolutely inside it.
 */
import { Soksak } from './soksak.js';
import type { Card, Rect } from './soksak.js';
export type ChangeReason = 'drag' | 'center' | 'merge' | 'resize' | 'render';
export interface ViewOptions {
    /**
     * Build the element for a card. Called once per card; the returned element is
     * reused across renders, so a live surface inside it survives splits, closes
     * and drags. The view sets only `position`, `left`, `top`, `width`, `height`.
     */
    createCard(card: Card): HTMLElement;
    /** Called on every render for every card, after the rect is applied. */
    updateCard?(el: HTMLElement, card: Card, rect: Rect): void;
    /** Called when a card element is about to be removed. */
    destroyCard?(el: HTMLElement, card: Card): void;
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
    private cardEls;
    private dividerEls;
    private ruleEls;
    /**
     * One drag per pointer. A single field meant a second finger overwrote the
     * first, so the divider still under the first finger drove the second one's
     * line and kept `data-dragging` forever.
     */
    private drags;
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
    /** The element currently showing a card, if any. */
    element(id: string): HTMLElement | undefined;
    destroy(): void;
}
