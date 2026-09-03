/// <reference lib="dom" />
/**
 * DOM binding for `Soksak`.
 *
 * The view sets position, manages element lifecycle and handles pointer input.
 * Card elements come from the host's `createCard` callback; on those the view
 * writes `position`, `left`, `top`, `width`, `height` and `data-card-id`.
 *
 * It creates two kinds of element of its own. A rule carries `class`,
 * `data-axis`, `data-virtual`, and `position`, `pointer-events: none`, `left`,
 * `top`, `width`, `height`. A divider carries `class`, `data-axis`,
 * `data-line`, `data-dragging` while held, `tabindex="0"`, `role="separator"`,
 * and `position`, `touch-action: none`, `left`, `top`, `width`, `height`.
 *
 * The host element needs a non-static `position`; the view places children
 * absolutely inside it.
 */
import { Soksak } from './soksak.js';
import type { Card, Rect } from './soksak.js';
export type ChangeReason = 'drag' | 'center' | 'merge' | 'resize' | 'render';
export interface ViewOptions {
    /**
     * Build the element for a card. Called once per card. The element is reused
     * across renders. The view sets `position`, `left`, `top`, `width`, `height`
     * and `data-card-id` on it, and nothing else.
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
    /**
     * How far past the plane a rule may run to reach the frame around it.
     *
     * A host that holds the plane inside a frame draws its border that far from
     * where a rule ends, and the rule reads as a line that gave up. Only the host
     * knows the distance — the view is handed an element, and an element's own
     * padding does not move what is placed absolutely inside it. Default 0.
     */
    bleed?: number;
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
     * One drag state per pointer id. A single shared field let a second pointer
     * overwrite the first, which moved the wrong boundary and left `data-dragging`
     * set on a divider nobody was holding.
     */
    private drags;
    private observer;
    private disposed;
    constructor(host: HTMLElement, grid: Soksak, options: ViewOptions);
    /** Re-place every element from the grid. Cheap enough to call on every frame of a drag. */
    render(reason?: ChangeReason): void;
    private sweep;
    /**
     * End a drag and report whether it moved the boundary.
     *
     * Every way a drag can end runs through here: pointerup, pointercancel, the
     * capture being lost, the divider being swept, and destroy.
     */
    private end;
    /**
     * Dividers are reused across renders. Rebuilding one mid-drag drops its
     * pointer capture: the boundary jumps once and then stops responding.
     */
    private makeDivider;
    /** The element currently showing a card, if any. */
    element(id: string): HTMLElement | undefined;
    destroy(): void;
}
