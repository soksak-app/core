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
const DOUBLE_TAP_MS = 350;
export class SoksakView {
    constructor(host, grid, options) {
        var _a;
        this.paneEls = new Map();
        this.dividerEls = new Map();
        this.ruleEls = new Map();
        this.drag = null;
        this.observer = null;
        this.disposed = false;
        this.host = host;
        this.grid = grid;
        this.options = options;
        this.prefix = (_a = options.classPrefix) !== null && _a !== void 0 ? _a : 'sp';
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
    render(reason = 'render') {
        var _a, _b, _c, _d, _e, _f;
        if (this.disposed)
            return;
        const live = new Set();
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
            (_b = (_a = this.options).updatePane) === null || _b === void 0 ? void 0 : _b.call(_a, held.el, pane, rect);
        }
        // the pane is already gone from the grid, so hand back the last one we saw
        for (const [id, held] of this.paneEls) {
            if (live.has(id))
                continue;
            (_d = (_c = this.options).destroyPane) === null || _d === void 0 ? void 0 : _d.call(_c, held.el, held.pane);
            held.el.remove();
            this.paneEls.delete(id);
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
            el.remove();
            map.delete(k);
        }
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
            e.preventDefault();
            const axis = el.dataset.axis;
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
        el.addEventListener('pointermove', (e) => {
            const drag = this.drag;
            if (!drag)
                return;
            const along = drag.axis === 'x' ? this.grid.width : this.grid.height;
            const now = drag.axis === 'x' ? e.clientX : e.clientY;
            if (Math.abs(now - drag.from) > 2)
                drag.moved = true;
            this.grid.moveLine(drag.axis, drag.line, drag.base + (now - drag.from) / along);
            this.render('drag');
        });
        const stop = (e) => {
            const drag = this.drag;
            if (!drag)
                return;
            try {
                el.releasePointerCapture(e.pointerId);
            }
            catch {
                /* the pointer may already be gone */
            }
            // a press that actually dragged must not arm the next one as a double tap
            if (drag.moved)
                lastTap = -Infinity;
            const merged = this.grid.mergeCoincident(drag.axis, drag.line);
            this.drag = null;
            delete el.dataset.dragging;
            this.render(merged ? 'merge' : 'drag');
        };
        el.addEventListener('pointerup', stop);
        el.addEventListener('pointercancel', stop);
        el.addEventListener('keydown', (e) => {
            const axis = el.dataset.axis;
            const line = Number(el.dataset.line);
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.grid.centerLine(axis, line);
                this.render('center');
                return;
            }
            const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
            if (step === undefined)
                return;
            e.preventDefault();
            const along = axis === 'x' ? this.grid.width : this.grid.height;
            this.grid.moveLine(axis, line, this.grid.lines(axis)[line] + (step * 8) / along);
            this.render('drag');
        });
        this.host.appendChild(el);
        return el;
    }
    /** The element currently showing a pane, if any. */
    element(id) {
        var _a;
        return (_a = this.paneEls.get(id)) === null || _a === void 0 ? void 0 : _a.el;
    }
    destroy() {
        var _a, _b, _c;
        this.disposed = true;
        (_a = this.observer) === null || _a === void 0 ? void 0 : _a.disconnect();
        this.observer = null;
        for (const held of this.paneEls.values()) {
            (_c = (_b = this.options).destroyPane) === null || _c === void 0 ? void 0 : _c.call(_b, held.el, held.pane);
            held.el.remove();
        }
        this.paneEls.clear();
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
