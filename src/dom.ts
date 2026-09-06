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
  private mouseDrag: DragState | null = null;
  /**
   * The divider a key is addressing, for the length of that key's draw. The
   * keyboard is not a drag, so without this `refile` does not follow the
   * element when the key renumbers, and the sweep removes it from under the
   * focus.
   */
  private pressed: DragState | null = null;
  private mouseDisposers = new Map<HTMLElement, () => void>();
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
        // A resize moves the boundary a drag is holding. The drag holds the
        // position that boundary stood at when it was pressed, so it has to be
        // carried by the same amount the resize moved it; otherwise the next
        // move puts the boundary where it would have gone on the old plane.
        const live = this.holds();
        const was = live.map((drag) => this.grid.boundaryPos(drag.axis, drag.line));
        this.grid.resize(host.clientWidth, host.clientHeight);
        live.forEach((drag, i) => {
          drag.base += this.grid.boundaryPos(drag.axis, drag.line) - was[i];
        });
        this.draw('resize');
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
    this.draw(reason);
  }

  /**
   * Draw through the host's commit hook.
   *
   * Every draw goes through here, not only a drag: a host that moves things this
   * view does not draw has to move them for a centre, a merge, a resize and a
   * change it makes itself as well, or those land a frame apart.
   */
  private draw(reason: ChangeReason): void {
    // A destroyed view draws nothing, and the hook is where a host moves the
    // views it draws itself. Calling it would move them onto the rects of a
    // plane that is gone.
    if (this.disposed) return;
    const drawn = (): void => this.paint(reason);
    if (!this.options.commit) {
      drawn();
      return;
    }
    // The host places its own views on these rects, so they are the rects the
    // render will write, not the ones the grid computed.
    const step = this.step;
    const on = new Map<string, Rect>();
    for (const [id, rect] of this.grid.rects()) on.set(id, onGrid(rect, step));
    this.options.commit(on, drawn);
  }

  /**
   * Draw the plane.
   *
   * The draw runs through `commit`, so a host that changes the grid itself is
   * told where the cards are going before they are drawn there, as a drag is.
   */
  render(reason: ChangeReason = 'render'): void {
    this.draw(reason);
  }

  private paint(reason: ChangeReason): void {
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
        // Rules and dividers are drawn over the cards and carry no z-index, so
        // paint and hit order is tree order. A card element appended after them
        // would cover the grab area of every divider it touches.
        this.host.insertBefore(el, this.firstOverlay());
        held = { el, card };
        this.cardEls.set(card.id, held);
      }
      held.card = card;
      const rect = onGrid(box.get(card.id) as Rect, step);
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
          el = this.host.ownerDocument.createElement('div');
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
        place(el, onGrid(reach(rule, this.grid, this.options.bleed ?? 0), step));
      }
      this.sweep(this.ruleEls, keep);
    }

    const dividers = this.grid.dividers();
    // A drag that has passed a line no card reads holds a boundary that has been
    // renumbered, and its element is filed under a key no divider has any more.
    // File it under the one it has now, before the sweep takes it away.
    this.refile(dividers, step);
    const keep = new Set<string>();
    for (const divider of dividers) {
      keep.add(divider.key);
      let el = this.dividerEls.get(divider.key);
      if (!el) {
        el = this.makeDivider();
        el.dataset.axis = divider.axis;
        el.dataset.line = String(divider.line);
        this.dividerEls.set(divider.key, el);
      }
      place(el, onGrid(divider, step));
      this.options.updateDivider?.(el, divider);
    }
    this.sweep(this.dividerEls, keep);

    this.options.onChange?.(reason);
  }

  /**
   * The first rule or divider element in the host, or null when there is none.
   *
   * A card element is inserted before it, so a card created after the rules and
   * dividers still sits under them.
   */
  private firstOverlay(): HTMLElement | null {
    return this.host.querySelector(
      `:scope > .${this.prefix}-rule, :scope > .${this.prefix}-divider`,
    );
  }

  /** Every drag now running, the mouse's included. */
  private holds(): DragState[] {
    const live = [...this.drags.values()];
    if (this.mouseDrag) live.push(this.mouseDrag);
    if (this.pressed) live.push(this.pressed);
    return live;
  }

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
  private carry(change: () => number, on: HTMLElement | null): number {
    const live = this.holds();
    const was = live.map((drag) => this.grid.boundaryPos(drag.axis, drag.line));
    const at = change();
    live.forEach((drag, i) => {
      const stands = drag.on === on ? at : was[i];
      let line = drag.line;
      let near = Infinity;
      for (let k = Math.min(drag.line, this.grid.lines(drag.axis).length - 2); k >= 1; k--) {
        const off = Math.abs(this.grid.boundaryPos(drag.axis, k) - stands);
        if (off < near) {
          near = off;
          line = k;
        }
      }
      drag.line = line;
      if (drag.on !== on) drag.base += this.grid.boundaryPos(drag.axis, line) - was[i];
    });
    return at;
  }

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
  private refile(dividers: readonly Divider[], step: number): void {
    const moving: { drag: DragState; was: string }[] = [];
    for (const drag of this.holds()) {
      // More than one gesture can hold one divider, and they hold one boundary
      // between them, so the element moves once.
      if (moving.some((m) => m.drag.on === drag.on)) continue;
      let was: string | undefined;
      for (const [key, el] of this.dividerEls) if (el === drag.on) was = key;
      // The key it is filed under carries a line number, and after a renumber
      // that number belongs to another boundary, so the key can still be one a
      // divider has. What says the element has to move is the line.
      if (was === undefined || dividers.some((d) => d.key === was && d.line === drag.line)) continue;
      moving.push({ drag, was });
    }
    // All of them leave the map before any of them is filed again, because one
    // can want the key another is about to leave.
    for (const { was } of moving) this.dividerEls.delete(was);
    for (const { drag } of moving) {
      let to: Divider | undefined;
      let best = 0;
      for (const d of dividers) {
        if (d.axis !== drag.axis || d.line !== drag.line || this.holding(d.key)) continue;
        const over = across(drag.on, onGrid(d, step), d.axis);
        if (over > best) {
          best = over;
          to = d;
        }
      }
      if (!to) {
        // The boundary it held is gone. It goes the way the sweep takes an
        // element away, because the sweep no longer sees it.
        this.forget(drag.on);
        continue;
      }
      const sitting = this.dividerEls.get(to.key);
      if (sitting !== undefined) this.forget(sitting);
      this.dividerEls.set(to.key, drag.on);
      drag.on.dataset.line = String(to.line);
    }
  }

  /** Whether a gesture holds the element filed under this key. */
  private holding(key: string): boolean {
    const el = this.dividerEls.get(key);
    return el !== undefined && this.holds().some((drag) => drag.on === el);
  }

  /** Drop what holds this element, remove its listeners, remove it. */
  private forget(el: HTMLElement): void {
    // The drag is dropped rather than ended. This runs inside render, and
    // ending a drag draws, which would start that render again from inside
    // itself, on a grid the merge has changed.
    for (const [pointer, drag] of [...this.drags]) if (drag.on === el) this.drop(pointer);
    // The mouse listeners are on the document, so removing the element does
    // not remove them. Left behind, they keep driving the boundary of a
    // divider that is gone, and they accumulate one pair per divider. The
    // disposer drops that divider's mouse drag before it removes them.
    this.mouseDisposers.get(el)?.();
    el.remove();
  }

  private sweep(map: Map<string, HTMLElement>, keep: Set<string>): void {
    for (const [k, el] of map) {
      if (keep.has(k)) continue;
      this.forget(el);
      map.delete(k);
    }
  }

  /**
   * Whether anything still holds this divider.
   *
   * More than one pointer can hold one divider, and the mouse can hold it as
   * well. Letting go of one of them is not letting go of the divider.
   */
  private held(el: HTMLElement): boolean {
    if (this.mouseDrag?.on === el) return true;
    for (const drag of this.drags.values()) if (drag.on === el) return true;
    return false;
  }

  /** A divider carries `data-dragging` for as long as anything holds it. */
  private mark(el: HTMLElement): void {
    if (this.held(el)) el.dataset.dragging = 'true';
    else delete el.dataset.dragging;
  }

  /** Drop a mouse drag: the divider stops being held and nothing is drawn. */
  private dropMouse(): DragState | null {
    const drag = this.mouseDrag;
    if (!drag) return null;
    this.mouseDrag = null;
    this.mark(drag.on);
    return drag;
  }

  /** Drop a pointer drag: the capture is released and nothing is drawn. */
  private drop(pointer: number): DragState | null {
    const drag = this.drags.get(pointer);
    if (!drag) return null;
    this.drags.delete(pointer);
    try {
      drag.on.releasePointerCapture(pointer);
    } catch {
      /* the pointer may already be gone */
    }
    this.mark(drag.on);
    return drag;
  }

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
  private endMouse(): boolean {
    const drag = this.dropMouse();
    if (!drag) return false;
    // The boundary it held is folded away, so no drag is on the divider the
    // merge addresses; a drag that stood where it stood keeps it.
    let merged = false;
    this.carry(() => {
      merged = this.grid.mergeCoincident(drag.axis, drag.line);
      return 0;
    }, null);
    this.draw(merged ? 'merge' : 'drag');
    return drag.moved;
  }

  /**
   * End a drag and report whether it moved the boundary.
   *
   * Every way a drag can end runs through here: pointerup, pointercancel, the
   * capture being lost, the divider being swept, and destroy.
   */
  private end(pointer: number): boolean {
    const drag = this.drop(pointer);
    if (!drag) return false;
    if (this.disposed) return drag.moved;
    // The boundary it held is folded away, so no drag is on the divider the
    // merge addresses; a drag that stood where it stood keeps it.
    let merged = false;
    this.carry(() => {
      merged = this.grid.mergeCoincident(drag.axis, drag.line);
      return 0;
    }, null);
    this.draw(merged ? 'merge' : 'drag');
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
    // The pointer whose press set `lastTap`. While that press is still down a
    // press landing now is a second finger and not the second of a pair; once it
    // has ended, whether it was released or dropped, the pair is open again.
    let tapId = -1;

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      // Only the primary button drags, as on the mouse path. A press of any
      // other button reports button 2 or 1 and its move reports the same
      // buttons bitmask a drag does, so without this it moves the boundary.
      if (this.disposed || e.button !== 0) return;
      e.preventDefault();
      const axis = el.dataset.axis as Axis;
      const line = Number(el.dataset.line);
      // A press with this pointer already down is a press the release of which
      // was never seen, as on the mouse path. Dropping it leaves no divider
      // marked as held with no drag behind it, which is a state nothing clears.
      if (this.drop(e.pointerId)?.moved) lastTap = -Infinity;
      // A press that lands while the press before it is still down is a second
      // finger, not the second press of a pair.
      if (this.drags.get(tapId)?.on !== el && e.timeStamp - lastTap < DOUBLE_TAP_MS) {
        lastTap = -Infinity;
        this.carry(() => this.grid.centerBoundary(axis, line), el);
        this.draw('center');
        return;
      }
      lastTap = e.timeStamp;
      tapId = e.pointerId;
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
        // The press that moved the boundary is not the first of a pair, on this
        // exit as on pointerup. This one is taken when the release itself was
        // never delivered.
        if (this.end(e.pointerId)) lastTap = -Infinity;
        return;
      }
      const now = drag.axis === 'x' ? e.clientX : e.clientY;
      if (Math.abs(now - drag.from) > 2) drag.moved = true;
      this.commit('drag', () =>
        this.carry(
          () => this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from)),
          el,
        ),
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
    // The second press of a double press centres the boundary, as it does on the
    // pointer path. A press that moved the boundary is not the first of a pair.
    let lastPress = -Infinity;
    const mouseDown = (e: MouseEvent): void => {
      if (this.disposed || e.button !== 0) return;
      e.preventDefault();
      const axis = el.dataset.axis as Axis;
      const line = Number(el.dataset.line);
      // A press with one already held is a press the release of which was never
      // seen. Dropping it leaves no divider marked as held with no drag behind
      // it, which is a state nothing ever clears. As on the other two exits, the
      // press that moved the boundary is not the first of a pair.
      if (this.dropMouse()?.moved) lastPress = -Infinity;
      if (e.timeStamp - lastPress < DOUBLE_TAP_MS) {
        lastPress = -Infinity;
        this.carry(() => this.grid.centerBoundary(axis, line), el);
        this.draw('center');
        return;
      }
      lastPress = e.timeStamp;
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
        // As on mouseup: a press that moved the boundary is not the first of a
        // pair. This exit is taken when the release itself was never delivered.
        if (this.endMouse()) lastPress = -Infinity;
        return;
      }
      const now = drag.axis === 'x' ? e.clientX : e.clientY;
      if (Math.abs(now - drag.from) > 2) drag.moved = true;
      this.commit('drag', () =>
        this.carry(
          () => this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from)),
          el,
        ),
      );
    };
    const mouseUp = (e: MouseEvent): void => {
      // Releasing another button while the primary one is still held does not
      // end the drag. mouseMove ends it when the primary button goes up.
      if (e.button !== 0) return;
      if (this.mouseDrag?.on !== el) return;
      if (this.endMouse()) lastPress = -Infinity;
    };
    el.addEventListener('mousedown', mouseDown);
    ownerDocument.addEventListener('mousemove', mouseMove);
    ownerDocument.addEventListener('mouseup', mouseUp);
    const disposeMouse = (): void => {
      if (this.mouseDrag?.on === el) this.dropMouse();
      el.removeEventListener('mousedown', mouseDown);
      ownerDocument.removeEventListener('mousemove', mouseMove);
      ownerDocument.removeEventListener('mouseup', mouseUp);
      this.mouseDisposers.delete(el);
    };
    this.mouseDisposers.set(el, disposeMouse);

    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (this.disposed) return;
      const axis = el.dataset.axis as Axis;
      const line = Number(el.dataset.line);
      // The record is set before the change runs, because that is when the line
      // each gesture holds is resolved.
      const held: DragState = { on: el, axis, line, from: 0, base: 0, moved: false };
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.pressed = held;
        try {
          this.carry(() => this.grid.centerBoundary(axis, line), el);
          this.draw('center');
        } finally {
          this.pressed = null;
        }
        return;
      }
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      this.pressed = held;
      try {
        this.commit('drag', () =>
          this.carry(
            () => this.grid.moveBoundary(axis, line, this.grid.boundaryPos(axis, line) + step * 8),
            el,
          ),
        );
      } finally {
        this.pressed = null;
      }
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
    for (const dispose of [...this.mouseDisposers.values()]) dispose();
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
 * How much of this rect the element is already drawn across.
 *
 * The coordinates across the line are the ones the element was last drawn with.
 * They tell two dividers standing on one line apart. A renumber on the other
 * axis moves the ends of the stretch in the same frame, so the answer is the
 * length the two share and not whether they match.
 */
function across(el: HTMLElement, rect: Rect, axis: Axis): number {
  const start = Number.parseFloat(axis === 'x' ? el.style.top : el.style.left);
  const end = start + Number.parseFloat(axis === 'x' ? el.style.height : el.style.width);
  const lo = axis === 'x' ? rect.y : rect.x;
  const hi = lo + (axis === 'x' ? rect.h : rect.w);
  return Math.min(end, hi) - Math.max(start, lo);
}

/**
 * Put a rect on the device's pixel grid.
 *
 * Sizes come from ratios, so an edge lands between two pixels, and everything
 * downstream then rounds on its own: the browser spreads a one pixel border over
 * two rows, and a native view placed on the same rect covers a different set of
 * pixels than that border did. This function is the one place that decides, and
 * every rect the view writes or reports passes through it.
 *
 * Edges are quantised, not sizes. Two cards that meet at a boundary derive their
 * facing edges from that one number, so both land on the same pixel and the
 * plane stays exactly covered; a width is whatever its two edges leave.
 */
function onGrid(rect: Rect, step: number): Rect {
  const x = Math.round(rect.x / step) * step;
  const y = Math.round(rect.y / step) * step;
  return {
    x,
    y,
    w: Math.round((rect.x + rect.w) / step) * step - x,
    h: Math.round((rect.y + rect.h) / step) * step - y,
  };
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
