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
/**
 * A rule that reaches the plane's edge carries on to the frame around it.
 *
 * Only at the ends that reach the plane: a rule that ends against a card is
 * left alone, because there the card is the wall.
 */
function reach(rule, grid, bleed) {
    if (bleed <= 0)
        return rule;
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
const DOUBLE_TAP_MS = 350;
export class SoksakView {
    /**
     * How far past the plane a rule may run to reach the frame around it.
     *
     * Writable, because a host that lets a person change its gap changes this
     * with it. Reads back what it holds, so a host does not have to remember
     * what it set.
     */
    get bleed() {
        var _a;
        return (_a = this.options.bleed) !== null && _a !== void 0 ? _a : 0;
    }
    set bleed(px) {
        if (!Number.isFinite(px) || px < 0)
            return;
        this.options.bleed = px;
    }
    constructor(host, grid, options) {
        var _a;
        this.cardEls = new Map();
        this.dividerEls = new Map();
        this.ruleEls = new Map();
        /**
         * One drag state per pointer id. A single shared field let a second pointer
         * overwrite the first, which moved the wrong boundary and left `data-dragging`
         * set on a divider nobody was holding.
         */
        this.drags = new Map();
        this.mouseDrag = null;
        this.mouseDisposers = new Set();
        this.observer = null;
        this.disposed = false;
        this.host = host;
        this.grid = grid;
        this.options = options;
        this.prefix = (_a = options.classPrefix) !== null && _a !== void 0 ? _a : 'sp';
        if (options.observeResize !== false && typeof ResizeObserver !== 'undefined') {
            this.observer = new ResizeObserver(() => {
                // A hidden host reports 0x0. Resizing to that drops every px size to 0
                // and showing the host again does not bring them back.
                if (host.clientWidth <= 0 || host.clientHeight <= 0)
                    return;
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
    render(reason = 'render') {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        var _j;
        if (this.disposed)
            return;
        // One measurement of the plane for every card. Asking for each card's rect
        // on its own rebuilt the whole coordinate system once per card, which is
        // what a drag pays on every pointer move.
        const box = this.grid.rects();
        const live = new Set();
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
            const rect = box.get(card.id);
            place(held.el, rect);
            (_b = (_a = this.options).updateCard) === null || _b === void 0 ? void 0 : _b.call(_a, held.el, card, rect);
        }
        // The card is gone from the grid, so `destroyCard` receives the last copy
        // the view held.
        for (const [id, held] of this.cardEls) {
            if (live.has(id))
                continue;
            (_d = (_c = this.options).destroyCard) === null || _d === void 0 ? void 0 : _d.call(_c, held.el, held.card);
            held.el.remove();
            this.cardEls.delete(id);
        }
        if (this.options.rules !== false) {
            const keep = new Set();
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
                place(el, reach(rule, this.grid, (_j = this.options.bleed) !== null && _j !== void 0 ? _j : 0));
            }
            this.sweep(this.ruleEls, keep);
        }
        const keep = new Set();
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
            (_f = (_e = this.options).updateDivider) === null || _f === void 0 ? void 0 : _f.call(_e, el, divider);
        }
        this.sweep(this.dividerEls, keep);
        (_h = (_g = this.options).onChange) === null || _h === void 0 ? void 0 : _h.call(_g, reason);
    }
    sweep(map, keep) {
        for (const [k, el] of map) {
            if (keep.has(k))
                continue;
            for (const [pointer, drag] of this.drags)
                if (drag.on === el)
                    this.end(pointer);
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
    end(pointer) {
        const drag = this.drags.get(pointer);
        if (!drag)
            return false;
        this.drags.delete(pointer);
        try {
            drag.on.releasePointerCapture(pointer);
        }
        catch {
            /* the pointer may already be gone */
        }
        delete drag.on.dataset.dragging;
        if (this.disposed)
            return drag.moved;
        const merged = this.grid.mergeCoincident(drag.axis, drag.line);
        this.render(merged ? 'merge' : 'drag');
        return drag.moved;
    }
    /**
     * Dividers are reused across renders. Rebuilding one mid-drag drops its
     * pointer capture: the boundary jumps once and then stops responding.
     */
    makeDivider() {
        const el = this.host.ownerDocument.createElement('div');
        el.className = `${this.prefix}-divider`;
        el.style.position = 'absolute';
        el.style.touchAction = 'none';
        el.tabIndex = 0;
        el.setAttribute('role', 'separator');
        // preventDefault on pointerdown suppresses the compatibility mouse events,
        // so `dblclick` never arrives. Detect the second press here instead.
        let lastTap = -Infinity;
        el.addEventListener('pointerdown', (e) => {
            if (this.disposed)
                return;
            e.preventDefault();
            const axis = el.dataset.axis;
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
            }
            catch {
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
        el.addEventListener('pointermove', (e) => {
            if (this.disposed)
                return;
            const drag = this.drags.get(e.pointerId);
            // Only the divider that started the drag continues it, and only while a
            // button is down. A drag whose divider is swept away never sees its own
            // pointerup, and the mouse is always pointer 1: without both checks that
            // one entry drags every other divider on a plain hover.
            if (!drag || drag.on !== el)
                return;
            if (e.buttons === 0) {
                this.end(e.pointerId);
                return;
            }
            const now = drag.axis === 'x' ? e.clientX : e.clientY;
            if (Math.abs(now - drag.from) > 2)
                drag.moved = true;
            this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from));
            this.render('drag');
        });
        const stop = (e) => {
            var _a;
            if (((_a = this.drags.get(e.pointerId)) === null || _a === void 0 ? void 0 : _a.on) !== el)
                return;
            if (this.end(e.pointerId))
                lastTap = -Infinity;
        };
        el.addEventListener('pointerup', stop);
        el.addEventListener('pointercancel', stop);
        // The browser drops the capture when the element leaves the document, and
        // then no pointerup reaches it.
        el.addEventListener('lostpointercapture', stop);
        // The public DOM command contract sends mouse events. Keep the same divider
        // state machine available for that contract without changing the grid API.
        const ownerDocument = el.ownerDocument;
        const mouseDown = (e) => {
            if (this.disposed || e.button !== 0)
                return;
            e.preventDefault();
            const axis = el.dataset.axis;
            const line = Number(el.dataset.line);
            this.mouseDrag = {
                on: el,
                axis,
                line,
                from: axis === 'x' ? e.clientX : e.clientY,
                base: this.grid.boundaryPos(axis, line),
                moved: false,
            };
        };
        const mouseMove = (e) => {
            const drag = this.mouseDrag;
            if (this.disposed || !drag || drag.on !== el)
                return;
            if (e.buttons === 0) {
                this.mouseDrag = null;
                return;
            }
            const now = drag.axis === 'x' ? e.clientX : e.clientY;
            if (Math.abs(now - drag.from) > 2)
                drag.moved = true;
            this.grid.moveBoundary(drag.axis, drag.line, drag.base + (now - drag.from));
            this.render('drag');
        };
        const mouseUp = () => {
            var _a;
            if (((_a = this.mouseDrag) === null || _a === void 0 ? void 0 : _a.on) === el)
                this.mouseDrag = null;
        };
        el.addEventListener('mousedown', mouseDown);
        ownerDocument.addEventListener('mousemove', mouseMove);
        ownerDocument.addEventListener('mouseup', mouseUp);
        const disposeMouse = () => {
            el.removeEventListener('mousedown', mouseDown);
            ownerDocument.removeEventListener('mousemove', mouseMove);
            ownerDocument.removeEventListener('mouseup', mouseUp);
            this.mouseDisposers.delete(disposeMouse);
        };
        this.mouseDisposers.add(disposeMouse);
        el.addEventListener('keydown', (e) => {
            if (this.disposed)
                return;
            const axis = el.dataset.axis;
            const line = Number(el.dataset.line);
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.grid.centerBoundary(axis, line);
                this.render('center');
                return;
            }
            const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
            if (step === undefined)
                return;
            e.preventDefault();
            this.grid.moveBoundary(axis, line, this.grid.boundaryPos(axis, line) + step * 8);
            this.render('drag');
        });
        this.host.appendChild(el);
        return el;
    }
    /** The element currently showing a card, if any. */
    element(id) {
        var _a;
        return (_a = this.cardEls.get(id)) === null || _a === void 0 ? void 0 : _a.el;
    }
    destroy() {
        var _a, _b, _c;
        this.disposed = true;
        for (const dispose of this.mouseDisposers)
            dispose();
        this.mouseDrag = null;
        for (const pointer of [...this.drags.keys()])
            this.end(pointer);
        (_a = this.observer) === null || _a === void 0 ? void 0 : _a.disconnect();
        this.observer = null;
        for (const held of this.cardEls.values()) {
            (_c = (_b = this.options).destroyCard) === null || _c === void 0 ? void 0 : _c.call(_b, held.el, held.card);
            held.el.remove();
        }
        this.cardEls.clear();
        for (const el of this.dividerEls.values())
            el.remove();
        this.dividerEls.clear();
        for (const el of this.ruleEls.values())
            el.remove();
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
function place(el, rect) {
    const s = el.style;
    const left = `${rect.x}px`;
    const top = `${rect.y}px`;
    const width = `${rect.w}px`;
    const height = `${rect.h}px`;
    if (s.left !== left)
        s.left = left;
    if (s.top !== top)
        s.top = top;
    if (s.width !== width)
        s.width = width;
    if (s.height !== height)
        s.height = height;
}
