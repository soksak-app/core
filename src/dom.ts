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
import type { Axis, Card, Divider, Rect, Rule } from './soksak.js';

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

/**
 * Extends a rule that reaches the plane's edge to the frame around it.
 *
 * Only the ends that reach the plane edge are extended. A rule ending against a
 * card is left unchanged.
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
  /**
   * One device pixel, in the units the rects are written in.
   *
   * The grid the elements are placed on. A display that draws two pixels per unit
   * halves it; a document without a window - a test, a detached tree - has no
   * grid finer than one unit.
   */
  private get step(): number {
    const dpr = this.host.ownerDocument?.defaultView?.devicePixelRatio;
    return typeof dpr === 'number' && dpr > 0 ? 1 / dpr : 1;
  }

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
  private mouseDrag: DragState | null = null;
  private mouseDisposers = new Set<() => void>();
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
  /**
   * Change the layout, then draw it.
   *
   * The model is changed first, because the rects a host is given have to be
   * the ones about to be drawn. Between that and the draw the page still shows
   * the layout before the change: a whole frame, not a torn one.
   */
  private commit(reason: ChangeReason, change: () => void): void {
    change();
    const draw = (): void => this.render(reason);
    if (this.options.commit) this.options.commit(this.grid.rects(), draw);
    else draw();
  }

  render(reason: ChangeReason = 'render'): void {
    if (this.disposed) return;

    // The width of one device pixel, read every render because a window moved to
    // another display gets a different one.
    const step = this.step;

    // One measurement for every card. Requesting each card's rect separately
    // rebuilt the whole coordinate system once per card, on every pointer move
    // of a drag.
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
      place(held.el, rect, step);
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
          // A rule is keyed by axis, line and whether it spans the whole plane,
          // so an element created under one key never holds another key's values.
          el.dataset.axis = rule.axis;
          el.dataset.virtual = String(rule.virtual);
          this.host.appendChild(el);
          this.ruleEls.set(rule.key, el);
        }
        place(el, reach(rule, this.grid, this.options.bleed ?? 0), step);
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
      place(el, divider, step);
      this.options.updateDivider?.(el, divider);
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
  /**
   * End a mouse drag.
   *
   * Every way a mouse drag can end runs through here: mouseup, the button being
   * released elsewhere, and destroy. It ends the way a pointer drag ends: the
   * divider stops carrying `data-dragging`, boundaries that now coincide are
   * merged, and the last render reports the reason drag.
   */
  private endMouse(): void {
    const drag = this.mouseDrag;
    if (!drag) return;
    this.mouseDrag = null;
    delete drag.on.dataset.dragging;
    if (this.disposed) return;
    const merged = this.grid.mergeCoincident(drag.axis, drag.line);
    this.render(merged ? 'merge' : 'drag');
  }

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
    const el = this.host.ownerDocument.createElement('div');
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
      this.commit('drag', () =>
        this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from)),
      );
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

    // The public DOM command contract sends mouse events. Keep the same divider
    // state machine available for that contract without changing the grid API.
    const ownerDocument = el.ownerDocument;
    const mouseDown = (e: MouseEvent): void => {
      if (this.disposed || e.button !== 0) return;
      e.preventDefault();
      const axis = el.dataset.axis as Axis;
      const line = Number(el.dataset.line);
      el.dataset.dragging = 'true';
      this.mouseDrag = {
        on: el,
        axis,
        line,
        from: axis === 'x' ? e.clientX : e.clientY,
        base: this.grid.boundaryPos(axis, line),
        moved: false,
      };
    };
    const mouseMove = (e: MouseEvent): void => {
      const drag = this.mouseDrag;
      if (this.disposed || !drag || drag.on !== el) return;
      if (e.buttons === 0) {
        this.endMouse();
        return;
      }
      const now = drag.axis === 'x' ? e.clientX : e.clientY;
      if (Math.abs(now - drag.from) > 2) drag.moved = true;
      this.commit('drag', () =>
        this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from)),
      );
    };
    const mouseUp = (): void => {
      if (this.mouseDrag?.on === el) this.endMouse();
    };
    el.addEventListener('mousedown', mouseDown);
    ownerDocument.addEventListener('mousemove', mouseMove);
    ownerDocument.addEventListener('mouseup', mouseUp);
    const disposeMouse = (): void => {
      if (this.mouseDrag?.on === el) this.endMouse();
      el.removeEventListener('mousedown', mouseDown);
      ownerDocument.removeEventListener('mousemove', mouseMove);
      ownerDocument.removeEventListener('mouseup', mouseUp);
      this.mouseDisposers.delete(disposeMouse);
    };
    this.mouseDisposers.add(disposeMouse);

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
      this.commit('drag', () =>
        this.grid.moveBoundary(axis, line, this.grid.boundaryPos(axis, line) + step * 8),
      );
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
    for (const dispose of this.mouseDisposers) dispose();
    this.mouseDrag = null;
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
 * Write the four position values that changed, on the device's pixel grid.
 *
 * A drag moves a handful of elements and leaves the rest where they are, so
 * comparing first turns a write per element per frame into a write per element
 * that moved. The last values are read back from the element, so nothing else
 * has to remember them.
 *
 * Sizes come from ratios, so an edge lands between two pixels, and everything
 * downstream then rounds on its own: the browser spreads a one pixel border over
 * two rows, and a native view placed on the same rect covers a different set of
 * pixels than that border did. This is the one place that decides, because the
 * rects written here are also the rects a page measures back off these elements
 * and hands to whatever draws above them.
 *
 * Edges are quantised, not sizes. Two cards that meet at a boundary derive their
 * facing edges from that one number, so both land on the same pixel and the
 * plane stays exactly covered; a width is whatever its two edges leave.
 */
function place(el: HTMLElement, rect: Rect, step: number): void {
  const s = el.style;
  const x = Math.round(rect.x / step) * step;
  const y = Math.round(rect.y / step) * step;
  const left = `${x}px`;
  const top = `${y}px`;
  const width = `${Math.round((rect.x + rect.w) / step) * step - x}px`;
  const height = `${Math.round((rect.y + rect.h) / step) * step - y}px`;
  if (s.left !== left) s.left = left;
  if (s.top !== top) s.top = top;
  if (s.width !== width) s.width = width;
  if (s.height !== height) s.height = height;
}
