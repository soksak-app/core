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
import type { Axis, Pane, Rect } from './soksak.js';

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
  private paneEls = new Map<string, { el: HTMLElement; pane: Pane }>();
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
    for (const pane of this.grid.panes) {
      live.add(pane.id);
      let held = this.paneEls.get(pane.id);
      if (!held) {
        const el = this.options.createPane(pane);
        el.style.position = 'absolute';
        this.host.appendChild(el);
        held = { el, pane };
        this.paneEls.set(pane.id, held);
      }
      held.pane = pane;
      const rect = this.grid.rectOf(pane);
      place(held.el, rect);
      held.el.dataset.paneId = pane.id;
      this.options.updatePane?.(held.el, pane, rect);
    }
    // the pane is already gone from the grid, so hand back the last one we saw
    for (const [id, held] of this.paneEls) {
      if (live.has(id)) continue;
      this.options.destroyPane?.(held.el, held.pane);
      held.el.remove();
      this.paneEls.delete(id);
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
        this.grid.centerLine(axis, line);
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
        base: this.grid.lines(axis)[line],
        moved: false,
      };
    });

    el.addEventListener('pointermove', (e: PointerEvent) => {
      const drag = this.drag;
      if (!drag) return;
      const along = drag.axis === 'x' ? this.grid.width : this.grid.height;
      const now = drag.axis === 'x' ? e.clientX : e.clientY;
      if (Math.abs(now - drag.from) > 2) drag.moved = true;
      this.grid.moveLine(drag.axis, drag.line, drag.base + (now - drag.from) / along);
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
        this.grid.centerLine(axis, line);
        this.render('center');
        return;
      }
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      const along = axis === 'x' ? this.grid.width : this.grid.height;
      this.grid.moveLine(axis, line, this.grid.lines(axis)[line] + (step * 8) / along);
      this.render('drag');
    });

    this.host.appendChild(el);
    return el;
  }

  /** The element currently showing a pane, if any. */
  element(id: string): HTMLElement | undefined {
    return this.paneEls.get(id)?.el;
  }

  destroy(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    for (const held of this.paneEls.values()) {
      this.options.destroyPane?.(held.el, held.pane);
      held.el.remove();
    }
    this.paneEls.clear();
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
