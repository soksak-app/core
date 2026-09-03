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
import type { Axis, Card, Rect, Rule } from './soksak.js';

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

/**
 * A rule that reaches the plane's edge carries on to the frame around it.
 *
 * Only at the ends that reach the plane: a rule that ends against a card is
 * left alone, because there the card is the wall.
 */
function reach(rule: Rule, grid: Soksak, bleed: number): Rect {
  if (bleed <= 0) return rule;
  if (rule.axis === 'x') {
    const head = rule.y <= EDGE ? bleed : 0;
    const tail = rule.y + rule.h >= grid.height - EDGE ? bleed : 0;
    return { x: rule.x, y: rule.y - head, w: rule.w, h: rule.h + head + tail };
  }
  const head = rule.x <= EDGE ? bleed : 0;
  const tail = rule.x + rule.w >= grid.width - EDGE ? bleed : 0;
  return { x: rule.x - head, y: rule.y, w: rule.w + head + tail, h: rule.h };
}

/** Near enough to the plane's edge to be at it. */
const EDGE = 0.5;

interface DragState {
  /** The divider that started it. Only that one may continue it. */
  on: HTMLElement;
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

  /**
   * How far past the plane a rule may run to reach the frame around it.
   *
   * Writable, because a host that lets a person change its gap changes this
   * with it. Reads back what it holds, so a host does not have to remember
   * what it set.
   */
  get bleed(): number {
    return this.options.bleed ?? 0;
  }

  set bleed(px: number) {
    if (!Number.isFinite(px) || px < 0) return;
    this.options.bleed = px;
  }
  private prefix: string;
  private cardEls = new Map<string, { el: HTMLElement; card: Card }>();
  private dividerEls = new Map<string, HTMLElement>();
  private ruleEls = new Map<string, HTMLElement>();
  /**
   * One drag state per pointer id. A single shared field let a second pointer
   * overwrite the first, which moved the wrong boundary and left `data-dragging`
   * set on a divider nobody was holding.
   */
  private drags = new Map<number, DragState>();
  private observer: ResizeObserver | null = null;
  private disposed = false;

  constructor(host: HTMLElement, grid: Soksak, options: ViewOptions) {
    this.host = host;
    this.grid = grid;
    this.options = options;
    this.prefix = options.classPrefix ?? 'sp';

    if (options.observeResize !== false && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        // A hidden host reports 0x0. Resizing to that drops every px size to 0
        // and showing the host again does not bring them back.
        if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
        this.grid.resize(host.clientWidth, host.clientHeight);
        this.render('resize');
      });
      this.observer.observe(host);
    }
    // Skip when the host has no layout: 0x0 would give every card no area.
    if (host.clientWidth > 0 && host.clientHeight > 0) {
      this.grid.resize(host.clientWidth, host.clientHeight);
    }
  }

  /** Re-place every element from the grid. Cheap enough to call on every frame of a drag. */
  render(reason: ChangeReason = 'render'): void {
    if (this.disposed) return;

    // One measurement of the plane for every card. Asking for each card's rect
    // on its own rebuilt the whole coordinate system once per card, which is
    // what a drag pays on every pointer move.
    const box = this.grid.rects();
    const live = new Set<string>();
    for (const card of this.grid.cards) {
      live.add(card.id);
      let held = this.cardEls.get(card.id);
      if (!held) {
        const el = this.options.createCard(card);
        el.style.position = 'absolute';
        el.dataset.cardId = card.id;
        this.host.appendChild(el);
        held = { el, card };
        this.cardEls.set(card.id, held);
      }
      held.card = card;
      const rect = box.get(card.id) as Rect;
      place(held.el, rect);
      this.options.updateCard?.(held.el, card, rect);
    }
    // The card is gone from the grid, so `destroyCard` receives the last copy
    // the view held.
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
          // A rule is keyed by axis, line and whether it runs the whole plane,
          // so an element built under one key never carries another's values.
          el.dataset.axis = rule.axis;
          el.dataset.virtual = String(rule.virtual);
          this.host.appendChild(el);
          this.ruleEls.set(rule.key, el);
        }
        place(el, reach(rule, this.grid, this.options.bleed ?? 0));
      }
      this.sweep(this.ruleEls, keep);
    }

    const keep = new Set<string>();
    for (const divider of this.grid.dividers()) {
      keep.add(divider.key);
      let el = this.dividerEls.get(divider.key);
      if (!el) {
        el = this.makeDivider();
        el.dataset.axis = divider.axis;
        el.dataset.line = String(divider.line);
        this.dividerEls.set(divider.key, el);
      }
      place(el, divider);
    }
    this.sweep(this.dividerEls, keep);

    this.options.onChange?.(reason);
  }

  private sweep(map: Map<string, HTMLElement>, keep: Set<string>): void {
    for (const [k, el] of map) {
      if (keep.has(k)) continue;
      for (const [pointer, drag] of this.drags) if (drag.on === el) this.end(pointer);
      el.remove();
      map.delete(k);
    }
  }

  /**
   * End a drag and report whether it moved the boundary.
   *
   * Every way a drag can end runs through here: pointerup, pointercancel, the
   * capture being lost, the divider being swept, and destroy.
   */
  private end(pointer: number): boolean {
    const drag = this.drags.get(pointer);
    if (!drag) return false;
    this.drags.delete(pointer);
    try {
      drag.on.releasePointerCapture(pointer);
    } catch {
      /* the pointer may already be gone */
    }
    delete drag.on.dataset.dragging;
    if (this.disposed) return drag.moved;
    const merged = this.grid.mergeCoincident(drag.axis, drag.line);
    this.render(merged ? 'merge' : 'drag');
    return drag.moved;
  }

  /**
   * Dividers are reused across renders. Rebuilding one mid-drag drops its
   * pointer capture: the boundary jumps once and then stops responding.
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
      if (this.disposed) return;
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
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture throws if the pointer is gone. Start the drag anyway.
      }
      el.dataset.dragging = 'true';
      this.drags.set(e.pointerId, {
        on: el,
        axis,
        line,
        from: axis === 'x' ? e.clientX : e.clientY,
        base: this.grid.boundaryPos(axis, line),
        moved: false,
      });
    });

    el.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.disposed) return;
      const drag = this.drags.get(e.pointerId);
      // Only the divider that started the drag continues it, and only while a
      // button is down. A drag whose divider is swept away never sees its own
      // pointerup, and the mouse is always pointer 1: without both checks that
      // one entry drags every other divider on a plain hover.
      if (!drag || drag.on !== el) return;
      if (e.buttons === 0) {
        this.end(e.pointerId);
        return;
      }
      const now = drag.axis === 'x' ? e.clientX : e.clientY;
      if (Math.abs(now - drag.from) > 2) drag.moved = true;
      this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from));
      this.render('drag');
    });

    const stop = (e: PointerEvent): void => {
      if (this.drags.get(e.pointerId)?.on !== el) return;
      if (this.end(e.pointerId)) lastTap = -Infinity;
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    // The browser drops the capture when the element leaves the document, and
    // then no pointerup reaches it.
    el.addEventListener('lostpointercapture', stop);

    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (this.disposed) return;
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
    for (const pointer of [...this.drags.keys()]) this.end(pointer);
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

/**
 * Write the four position values that changed.
 *
 * A drag moves a handful of elements and leaves the rest where they are, so
 * comparing first turns a write per element per frame into a write per element
 * that moved. The last values are read back from the element, so nothing else
 * has to remember them.
 */
function place(el: HTMLElement, rect: Rect): void {
  const s = el.style;
  const left = `${rect.x}px`;
  const top = `${rect.y}px`;
  const width = `${rect.w}px`;
  const height = `${rect.h}px`;
  if (s.left !== left) s.left = left;
  if (s.top !== top) s.top = top;
  if (s.width !== width) s.width = width;
  if (s.height !== height) s.height = height;
}
