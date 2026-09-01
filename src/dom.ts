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
import type { Axis, Card, Rect } from './soksak.js';

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

interface DragState {
  axis: Axis;
  line: number;
  from: number;
  base: number;
  moved: boolean;
}

const DOUBLE_TAP_MS = 350;

export class SoksakView {
  private host: HTMLElement;
  private grid: Soksak;
  private options: ViewOptions;
  private prefix: string;
  private cardEls = new Map<string, { el: HTMLElement; card: Card }>();
  private dividerEls = new Map<string, HTMLElement>();
  private ruleEls = new Map<string, HTMLElement>();
  private drag: DragState | null = null;
  private observer: ResizeObserver | null = null;
  private disposed = false;

  constructor(host: HTMLElement, grid: Soksak, options: ViewOptions) {
    this.host = host;
    this.grid = grid;
    this.options = options;
    this.prefix = options.classPrefix ?? 'sp';

    if (options.observeResize !== false && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        this.grid.resize(host.clientWidth, host.clientHeight);
        this.render('resize');
      });
      this.observer.observe(host);
    }
    this.grid.resize(host.clientWidth, host.clientHeight);
  }

  /** Re-place every element from the grid. Cheap enough to call on every frame of a drag. */
  render(reason: ChangeReason = 'render'): void {
    if (this.disposed) return;

    const live = new Set<string>();
    for (const card of this.grid.cards) {
      live.add(card.id);
      let held = this.cardEls.get(card.id);
      if (!held) {
        const el = this.options.createCard(card);
        el.style.position = 'absolute';
        this.host.appendChild(el);
        held = { el, card };
        this.cardEls.set(card.id, held);
      }
      held.card = card;
      const rect = this.grid.rectOf(card);
      place(held.el, rect);
      held.el.dataset.cardId = card.id;
      this.options.updateCard?.(held.el, card, rect);
    }
    // the card is already gone from the grid, so hand back the last one we saw
    for (const [id, held] of this.cardEls) {
      if (live.has(id)) continue;
      this.options.destroyCard?.(held.el, held.card);
      held.el.remove();
      this.cardEls.delete(id);
    }

    if (this.options.rules !== false) {
      const keep = new Set<string>();
      for (const rule of this.grid.rules()) {
        keep.add(rule.key);
        let el = this.ruleEls.get(rule.key);
        if (!el) {
          el = document.createElement('div');
          el.className = `${this.prefix}-rule`;
          el.style.position = 'absolute';
          el.style.pointerEvents = 'none';
          this.host.appendChild(el);
          this.ruleEls.set(rule.key, el);
        }
        el.dataset.axis = rule.axis;
        el.dataset.virtual = String(rule.virtual);
        place(el, rule);
      }
      this.sweep(this.ruleEls, keep);
    }

    const keep = new Set<string>();
    for (const divider of this.grid.dividers()) {
      keep.add(divider.key);
      let el = this.dividerEls.get(divider.key);
      if (!el) {
        el = this.makeDivider();
        this.dividerEls.set(divider.key, el);
      }
      el.dataset.axis = divider.axis;
      el.dataset.line = String(divider.line);
      place(el, divider);
      this.dividerEls.set(divider.key, el);
    }
    this.sweep(this.dividerEls, keep);

    this.options.onChange?.(reason);
  }

  private sweep(map: Map<string, HTMLElement>, keep: Set<string>): void {
    for (const [k, el] of map) {
      if (keep.has(k)) continue;
      el.remove();
      map.delete(k);
    }
  }

  /**
   * Dividers are reused across renders. Rebuilding one mid-drag would drop its
   * pointer capture, which reads as the boundary jumping once and then going dead.
   */
  private makeDivider(): HTMLElement {
    const el = document.createElement('div');
    el.className = `${this.prefix}-divider`;
    el.style.position = 'absolute';
    el.style.touchAction = 'none';
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');

    // preventDefault on pointerdown suppresses the compatibility mouse events,
    // so `dblclick` never arrives. Detect the second press here instead.
    let lastTap = -Infinity;

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      const axis = el.dataset.axis as Axis;
      const line = Number(el.dataset.line);
      if (e.timeStamp - lastTap < DOUBLE_TAP_MS) {
        lastTap = -Infinity;
        this.grid.centerBoundary(axis, line);
        this.render('center');
        return;
      }
      lastTap = e.timeStamp;
      el.setPointerCapture(e.pointerId);
      el.dataset.dragging = 'true';
      this.drag = {
        axis,
        line,
        from: axis === 'x' ? e.clientX : e.clientY,
        base: this.grid.boundaryPos(axis, line),
        moved: false,
      };
    });

    el.addEventListener('pointermove', (e: PointerEvent) => {
      const drag = this.drag;
      if (!drag) return;
      const now = drag.axis === 'x' ? e.clientX : e.clientY;
      if (Math.abs(now - drag.from) > 2) drag.moved = true;
      this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from));
      this.render('drag');
    });

    const stop = (e: PointerEvent): void => {
      const drag = this.drag;
      if (!drag) return;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* the pointer may already be gone */
      }
      // a press that actually dragged must not arm the next one as a double tap
      if (drag.moved) lastTap = -Infinity;
      const merged = this.grid.mergeCoincident(drag.axis, drag.line);
      this.drag = null;
      delete el.dataset.dragging;
      this.render(merged ? 'merge' : 'drag');
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);

    el.addEventListener('keydown', (e: KeyboardEvent) => {
      const axis = el.dataset.axis as Axis;
      const line = Number(el.dataset.line);
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.grid.centerBoundary(axis, line);
        this.render('center');
        return;
      }
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      this.grid.moveBoundary(axis, line, this.grid.boundaryPos(axis, line) + step * 8);
      this.render('drag');
    });

    this.host.appendChild(el);
    return el;
  }

  /** The element currently showing a card, if any. */
  element(id: string): HTMLElement | undefined {
    return this.cardEls.get(id)?.el;
  }

  destroy(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    for (const held of this.cardEls.values()) {
      this.options.destroyCard?.(held.el, held.card);
      held.el.remove();
    }
    this.cardEls.clear();
    for (const el of this.dividerEls.values()) el.remove();
    this.dividerEls.clear();
    for (const el of this.ruleEls.values()) el.remove();
    this.ruleEls.clear();
  }
}

function place(el: HTMLElement, rect: Rect): void {
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
}
