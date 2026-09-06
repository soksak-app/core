/// <reference lib="dom" />
/**
 * DOM binding for `Soksak`.
 *
 * The view sets position, manages element lifecycle and handles pointer input.
 * Card elements come from the host's `createCard` callback; on those the view
 * writes `position`, `left`, `top`, `width`, `height` and `data-card-id`.
 *
 * It creates two kinds of element of its own. A rule has `class`, `data-axis`,
 * `data-virtual`, and `position`, `pointer-events: none`, `left`, `top`,
 * `width`, `height`. A divider has `class`, `data-axis`, `data-line`,
 * `data-dragging` while dragged, `tabindex="0"`, `role="separator"`, and
 * `position`, `touch-action: none`, `left`, `top`, `width`, `height`.
 *
 * The host element needs a non-static `position`; the view places children
 * absolutely inside it.
 */
import { Soksak } from './soksak.js';
import type { Card, Divider, Rect } from './soksak.js';
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
    /** Called on every render for every divider, after its rect is applied. */
    updateDivider?(el: HTMLElement, divider: Divider): void;
    /** Called when a card element is about to be removed. */
    destroyCard?(el: HTMLElement, card: Card): void;
    /** Class name stem for the elements the view creates. Default `sp`. */
    classPrefix?: string;
    /** Draw the boundary lines. Set false to draw them yourself from `grid.rules()`. Default true. */
    rules?: boolean;
    /** Fired after any interaction the view handled, and after `render()`. */
    onChange?(reason: ChangeReason): void;
    /**
     * Commit a layout change the view handled.
     *
     * Called with the rects the change will draw and the function that draws
     * them. A plane that holds more than DOM — an OS view composited over the
     * page, which no CSS reaches — has to move that too, and it moves on a
     * channel of its own. Whoever is slower goes first: put the other things
     * where these rects say, then draw. Both then land in one frame.
     *
     * Until `draw` is called the page still shows the layout before the change,
     * which is a whole frame and not a torn one. Not given, the change is drawn
     * at once.
     */
    commit?(rects: ReadonlyMap<string, Rect>, draw: () => void): void;
    /** Keep the plane size in sync with the host element. Default true. */
    observeResize?: boolean;
    /**
     * How far past the plane a rule may run to reach the frame around it.
     *
     * A host that places the plane inside a frame draws that frame's border this
     * far from where a rule ends, leaving a visible break. Only the host has that
     * distance: the view receives an element, and the element's own padding does
     * not move absolutely positioned children. Default 0.
     */
    bleed?: number;
}
export declare class SoksakView {
    private host;
    private grid;
    private options;
    /**
     * One device pixel, in the units the rects are written in.
     *
     * The grid the elements are placed on. A display that draws two pixels per unit
     * halves it; a document without a window - a test, a detached tree - has no
     * grid finer than one unit.
     */
    private get step();
    /**
     * How far past the plane a rule may run to reach the frame around it.
     *
     * Writable, because a host that lets a person change its gap changes this
     * with it. Reads back what it holds, so a host does not have to remember
     * what it set.
     */
    get bleed(): number;
    set bleed(px: number);
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
    private mouseDrag;
    /**
     * The divider a key is addressing, for the length of that key's draw. The
     * keyboard is not a drag, so without this `refile` does not follow the
     * element when the key renumbers, and the sweep removes it from under the
     * focus.
     */
    private pressed;
    private mouseDisposers;
    private observer;
    private disposed;
    constructor(host: HTMLElement, grid: Soksak, options: ViewOptions);
    /** Re-place every element from the grid. Cheap enough to call on every frame of a drag. */
    /**
     * Change the layout, then draw it.
     *
     * The model is changed first, because the rects a host is given have to be
     * the ones about to be drawn. Between that and the draw the page still shows
     * the layout before the change: a whole frame, not a torn one.
     */
    private commit;
    /**
     * Draw through the host's commit hook.
     *
     * Every draw goes through here, not only a drag: a host that moves things this
     * view does not draw has to move them for a centre, a merge, a resize and a
     * change it makes itself as well, or those land a frame apart.
     */
    private draw;
    /**
     * Draw the plane.
     *
     * The draw runs through `commit`, so a host that changes the grid itself is
     * told where the cards are going before they are drawn there, as a drag is.
     */
    render(reason?: ChangeReason): void;
    private paint;
    /**
     * The first rule or divider element in the host, or null when there is none.
     *
     * A card element is inserted before it, so a card created after the rules and
     * dividers still sits under them.
     */
    private firstOverlay;
    /** Every drag now running, the mouse's included. */
    private holds;
    /**
     * Run a change that renumbers lines and point every live drag at the line its
     * own boundary now has.
     *
     * A move, a merge and a centring all drop the lines no card reads that they
     * pass, and every line above a dropped one is renumbered. A drag holds a line
     * number, so each one has to be given the number its boundary now stands on,
     * or its next move addresses a different boundary and its element is filed
     * under a key no divider has.
     *
     * `on` is the divider the change addresses. The drags on it follow the
     * position the change returns; every other drag follows the position its own
     * boundary stood at before the change, and its press anchor moves by the same
     * amount the change moved that boundary, as the resize observer does.
     *
     * The line is the nearest one and not an exact match: dropping a line moves
     * what is left of the others by a rounding.
     */
    private carry;
    /**
     * File the element a drag holds under the key its boundary now has.
     *
     * The key carries the line number, so a renumber leaves the element filed
     * under a key no divider has and the sweep would remove it. That ends the
     * gesture: the pointer capture dies with the element, and an element made in
     * its place cannot pick the drag up.
     *
     * Two dividers can stand on one line, one per stretch of it that cards break
     * on, so the one to file under is the one covering most of the stretch this
     * element already covers. A renumber on the other axis moves the ends of that
     * stretch in the same frame, so the stretches are compared by overlap and not
     * by an exact match.
     */
    private refile;
    /** Whether a gesture holds the element filed under this key. */
    private holding;
    /** Drop what holds this element, remove its listeners, remove it. */
    private forget;
    private sweep;
    /**
     * Whether anything still holds this divider.
     *
     * More than one pointer can hold one divider, and the mouse can hold it as
     * well. Letting go of one of them is not letting go of the divider.
     */
    private held;
    /** A divider carries `data-dragging` for as long as anything holds it. */
    private mark;
    /** Drop a mouse drag: the divider stops being held and nothing is drawn. */
    private dropMouse;
    /** Drop a pointer drag: the capture is released and nothing is drawn. */
    private drop;
    /**
     * End a mouse drag.
     *
     * A mouse drag ends here on mouseup and when the button is released
     * elsewhere. A divider that is swept away, and destroy, drop the drag
     * instead, because a divider that is gone has nothing to draw. It ends the
     * way a pointer drag ends: the divider stops carrying `data-dragging`,
     * boundaries that now coincide are merged, and the last render reports the
     * reason drag. Returns whether the boundary moved.
     */
    private endMouse;
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
