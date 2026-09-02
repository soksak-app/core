/**
 * DOM binding for `Soksak`.
 *
 * The view sets position, manages element lifecycle and handles pointer input.
 * Card elements come from the host's `createCard` callback. The elements the
 * view creates carry a class name and data attributes and no inline styling
 * beyond position, left, top, width and height.
 *
 * The host element needs a non-static `position`; the view places children
 * absolutely inside it.
 */
const DOUBLE_TAP_MS = 350;
export class SoksakView {
    constructor(host, grid, options) {
        var _a;
        this.cardEls = new Map();
        this.dividerEls = new Map();
        this.ruleEls = new Map();
        /**
         * One drag state per pointer id. A single shared field let a second pointer
         * overwrite the first, so one divider drove another and kept `data-dragging`.
         */
        this.drags = new Map();
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
        var _a, _b, _c, _d, _e, _f;
        if (this.disposed)
            return;
        const live = new Set();
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
            (_b = (_a = this.options).updateCard) === null || _b === void 0 ? void 0 : _b.call(_a, held.el, card, rect);
        }
        // the card is already gone from the grid, so hand back the last one we saw
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
                    this.host.appendChild(el);
                    this.ruleEls.set(rule.key, el);
                }
                el.dataset.axis = rule.axis;
                el.dataset.virtual = String(rule.virtual);
                place(el, rule);
            }
            this.sweep(this.ruleEls, keep);
        }
        const keep = new Set();
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
        (_f = (_e = this.options).onChange) === null || _f === void 0 ? void 0 : _f.call(_e, reason);
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
     * Dividers are reused across renders. Rebuilding one mid-drag would drop its
     * pointer capture, which reads as the boundary jumping once and then going dead.
     */
    makeDivider() {
        const el = document.createElement('div');
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
        el.addEventListener('keydown', (e) => {
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
function place(el, rect) {
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
}
