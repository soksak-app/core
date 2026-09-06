/**
 * A soksak over shared grid lines.
 *
 * `xs` and `ys` hold every coordinate, normalised 0..1 over the slots that
 * share the remaining space. A slot with a px size is drawn at that size
 * whatever its span, so a line's px position is not its value times the plane
 * size. A card is a span of indices into them, so two cards that meet reference
 * the same index and their shared boundary is one value. Moving a line moves
 * every card that references it; a card spanning across it is unaffected.
 *
 * Splitting replaces one card with two, so the arrangement stays a slicing
 * floorplan and every card can be closed.
 *
 * This module holds the state and the operations. `geometry.ts` computes the
 * coordinates.
 */
import { AXES, SIDES, SPAN, axisOf, fixedSize, isAhead, other, spanOf } from './card.js';
import { corridorOf, crossing, dividers, frameOf, linesRead, halfCorridor, heldSizes, inset, interiorLines, isVirtual, linePositions, rectIn, rectOf, rules, slotSizes, slotWidths, zoneAt, } from './geometry.js';
import { fillFor, isSlicing } from './slicing.js';
const EPS = 1e-9;
/**
 * Slots to try when settling a change, nearest the boundary first: `from`,
 * then `back`, then outward from each.
 */
const order = (from, count, back = from - 1) => {
    const out = [];
    for (let step = 0; step < count; step++) {
        out.push(from + step, back - step);
    }
    return out.filter((i) => i >= 0 && i < count);
};
/**
 * Rejects a state that cannot describe a plane and reports which field is wrong.
 *
 * Without this check a stale layout read from storage reaches the geometry,
 * where an index outside the line array or a non-numeric coordinate produces a
 * NaN rect. In the DOM that becomes `left: NaNpx`, which the CSSOM discards, so
 * the view stops at its last valid layout and reports nothing.
 */
export function checkState(state) {
    const bad = (why) => {
        throw new TypeError(`soksak: ${why}`);
    };
    for (const axis of ['xs', 'ys']) {
        const a = state === null || state === void 0 ? void 0 : state[axis];
        if (!Array.isArray(a) || a.length < 2)
            bad(`${axis} needs at least two lines`);
        for (const [i, v] of a.entries()) {
            if (!Number.isFinite(v))
                bad(`${axis}[${i}] is ${String(v)}`);
            if (i > 0 && v < a[i - 1])
                bad(`${axis}[${i}] is before ${axis}[${i - 1}]`);
        }
    }
    if (!Array.isArray(state.cards) || state.cards.length === 0)
        bad('cards is empty');
    const seen = new Set();
    for (const c of state.cards) {
        if (typeof (c === null || c === void 0 ? void 0 : c.id) !== 'string' || !c.id)
            bad('a card has no id');
        if (seen.has(c.id))
            bad(`two cards are called ${c.id}`);
        seen.add(c.id);
        for (const [lo, hi, axis] of [
            ['c0', 'c1', 'xs'],
            ['r0', 'r1', 'ys'],
        ]) {
            const a = state[axis];
            const from = c[lo];
            const to = c[hi];
            if (!Number.isInteger(from) || !Number.isInteger(to))
                bad(`${c.id}.${lo}/${hi} is not an index`);
            if (from < 0 || to > a.length - 1)
                bad(`${c.id}.${lo}/${hi} is outside ${axis}`);
            if (to <= from)
                bad(`${c.id}.${hi} is not past ${c.id}.${lo}`);
        }
    }
}
const clamp = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
export class Soksak {
    /** Gap between two cards, in px. Clamped to 0; a negative value overlaps cards. */
    get gap() {
        return this.g;
    }
    set gap(px) {
        if (!Number.isFinite(px) || px < 0)
            return;
        this.g = px;
        this.splitMemo.clear();
    }
    /** Minimum drawn size of a card on either axis. */
    get minSize() {
        return this.min;
    }
    /** Assigning it clears the values cached against the previous one. */
    set minSize(px) {
        if (!Number.isFinite(px) || px < 0)
            return;
        this.min = px;
        this.splitMemo.clear();
    }
    /** The axis a close tries first. */
    get fillOrder() {
        return this.order;
    }
    set fillOrder(value) {
        if (value !== 'v' && value !== 'h')
            return;
        this.order = value;
        this.sliceMemo.clear();
        this.splitMemo.clear();
    }
    /** Smallest grab area of a boundary, in px. */
    get grabSize() {
        return this.grab;
    }
    set grabSize(px) {
        if (!Number.isFinite(px) || px < 0)
            return;
        this.grab = px;
    }
    /** How near a dragged boundary must come to a neighbour to land on it, in px. */
    get snapDistance() {
        return this.snapAt;
    }
    set snapDistance(px) {
        if (!Number.isFinite(px) || px < 0)
            return;
        this.snapAt = px;
    }
    /** Whether a dragged boundary lands on a neighbour it nearly meets. */
    get snap() {
        return this.snapMode;
    }
    set snap(mode) {
        if (mode !== 'merge' && mode !== 'off')
            return;
        this.snapMode = mode;
    }
    /** With no state, starts as one card filling the plane. */
    constructor(state, options = {}) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        this.seq = 0;
        this.sliceMemo = new Map();
        this.splitMemo = new Map();
        /**
         * Which side of a card's slot gave up the span it occupies, by card id.
         *
         * `split` and `insertAt` take the span from one neighbour. A close returns it
         * by removing the line on that side, so the two operations are inverses.
         * Without this the space goes to whichever neighbour the fill selects, and
         * repeating split and close reduces one card to `minSize`.
         */
        this.paidBy = new Map();
        /** True while canSplit runs a trial split and restores the state. */
        this.probing = false;
        this.g = 24;
        this.gap = (_a = options.gap) !== null && _a !== void 0 ? _a : 24;
        const min = (_b = options.minSize) !== null && _b !== void 0 ? _b : 96;
        this.min = Number.isFinite(min) && min >= 0 ? min : 96;
        // Every option is checked the same way. A number that is not one puts NaN
        // into every rect the plane computes, and the elements then carry a length
        // the CSSOM discards.
        this.grab = 11;
        this.grabSize = (_c = options.grabSize) !== null && _c !== void 0 ? _c : 11;
        this.snapAt = 7;
        this.snapDistance = (_d = options.snapDistance) !== null && _d !== void 0 ? _d : 7;
        this.snapMode = 'merge';
        this.snap = (_e = options.snap) !== null && _e !== void 0 ? _e : 'merge';
        this.order = (_f = options.fillOrder) !== null && _f !== void 0 ? _f : 'v';
        this.w = 0;
        this.h = 0;
        this.resize((_g = options.width) !== null && _g !== void 0 ? _g : 0, (_h = options.height) !== null && _h !== void 0 ? _h : 0);
        if (state) {
            checkState(state);
            this.xs = [...state.xs];
            this.ys = [...state.ys];
            this.list = state.cards.map((c) => { var _a; return ({ ...c, fixed: (_a = c.fixed) !== null && _a !== void 0 ? _a : false }); });
            this.paidBy = new Map(Object.entries((_j = state.paidBy) !== null && _j !== void 0 ? _j : {}));
        }
        else {
            this.xs = [0, 1];
            this.ys = [0, 1];
            this.list = [{ id: 'card', c0: 0, c1: 1, r0: 0, r1: 1, fixed: false }];
        }
        this.agreeSizes();
    }
    static from(state, options) {
        return new Soksak(state, options);
    }
    // ---- the plane ---------------------------------------------------------
    resize(width, height) {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
            return;
        }
        this.w = width;
        this.h = height;
        this.splitMemo.clear(); // plane size changes the answer
    }
    get width() {
        return this.w;
    }
    get height() {
        return this.h;
    }
    /**
     * Every card, as frozen copies.
     *
     * Writes to the returned objects do not affect the grid. Use `setFixed`,
     * `setSize` and `setData` to change a card.
     */
    get cards() {
        return this.list.map((c) => Object.freeze({ ...c }));
    }
    card(id) {
        const found = this.find(id);
        return found && Object.freeze({ ...found });
    }
    /**
     * Replace a card's payload.
     *
     * `data` is opaque to this library.
     */
    setData(id, data) {
        const card = this.find(id);
        if (!card)
            return false;
        card.data = data;
        return true;
    }
    /**
     * Set whether the layout may split, close or move a card.
     */
    setFixed(id, fixed) {
        const card = this.find(id);
        if (!card)
            return false;
        card.fixed = fixed;
        // splitMemo and sliceMemo were computed with the previous `fixed` value.
        // A fixed card never fills for a closing neighbour, so both results change.
        this.splitMemo.clear();
        this.sliceMemo.clear();
        return true;
    }
    /**
     * Sets a card's px width or height. `null` removes the size and the card takes
     * a share of the remainder.
     *
     * The size applies to the slot, so it is written to every card in that slot.
     * Returns false for an unknown axis, a negative or non-finite size, or a card
     * spanning more than one slot on that axis.
     */
    setSize(id, axis, px) {
        if (this.noAxis(axis))
            return false;
        const card = this.find(id);
        if (!card)
            return false;
        if (px !== null && (!Number.isFinite(px) || px < 0 || spanOf(card, axis) !== 1))
            return false;
        // Every card with the same span on this axis is in the same slot.
        const [lo, hi] = SPAN[axis];
        for (const c of this.list) {
            if (c[lo] !== card[lo] || c[hi] !== card[hi])
                continue;
            if (axis === 'x') {
                if (px === null)
                    delete c.width;
                else
                    c.width = px;
            }
            else if (px === null)
                delete c.height;
            else
                c.height = px;
        }
        this.changed();
        return true;
    }
    /** The card itself, for the operations that change it. */
    find(id) {
        return this.list.find((c) => c.id === id);
    }
    /** Grid line coordinates, normalised 0..1. A copy — the arrangement owns them. */
    lines(axis) {
        if (this.noAxis(axis))
            return [];
        return [...(axis === 'x' ? this.xs : this.ys)];
    }
    toJSON() {
        return {
            xs: [...this.xs],
            ys: [...this.ys],
            cards: this.list.map((c) => ({ ...c })),
            paidBy: Object.fromEntries(this.paidBy),
        };
    }
    /**
     * Replace the arrangement while keeping this grid's plane and options.
     *
     * The payload is opaque to the library. This is the synchronization point
     * for a host that owns the canonical state and keeps one DOM view alive.
     */
    replace(state) {
        var _a;
        checkState(state);
        this.xs = [...state.xs];
        this.ys = [...state.ys];
        this.list = state.cards.map((c) => { var _a; return ({ ...c, fixed: (_a = c.fixed) !== null && _a !== void 0 ? _a : false }); });
        this.paidBy = new Map(Object.entries((_a = state.paidBy) !== null && _a !== void 0 ? _a : {}));
        this.sliceMemo.clear();
        this.splitMemo.clear();
        this.agreeSizes();
    }
    get plane() {
        return { xs: this.xs, ys: this.ys, cards: this.list, width: this.w, height: this.h, gap: this.gap, minSize: this.min };
    }
    arr(axis) {
        return axis === 'x' ? this.xs : this.ys;
    }
    /** Rejects an axis value the caller invented. Every public method that takes one checks it. */
    noAxis(axis) {
        return axis !== 'x' && axis !== 'y';
    }
    size(axis) {
        return axis === 'x' ? this.w : this.h;
    }
    // ---- reading the arrangement -------------------------------------------
    rectOf(card) {
        return rectOf(this.plane, card);
    }
    rect(id) {
        const card = this.find(id);
        return card && this.rectOf(card);
    }
    rects() {
        const frame = frameOf(this.plane); // measured once, not once per card
        return new Map(this.list.map((c) => [c.id, rectIn(frame, c)]));
    }
    /**
     * Where a drop lands — which card, and whether on it or beside it.
     *
     * The point is in the plane's own coordinates, the ones `rects()` reports.
     */
    zoneAt(x, y, options = {}) {
        return zoneAt(this.plane, x, y, options);
    }
    /** Cards that span across a line, as frozen copies. They are what a card placed on it would cut. */
    cardsCrossing(axis, line) {
        if (this.noAxis(axis))
            return [];
        return crossing(this.plane, axis, line).map((c) => Object.freeze({ ...c }));
    }
    /** How many lines a card spans across — how much finer its neighbours are. */
    crossings(card) {
        return Math.max(0, card.c1 - card.c0 - 1) + Math.max(0, card.r1 - card.r0 - 1);
    }
    /** True when no card reads this line — it survives only as a snap target. */
    isVirtual(axis, line) {
        if (this.noAxis(axis))
            return false;
        return isVirtual(this.plane, axis, line);
    }
    virtualCount() {
        let n = 0;
        for (const axis of AXES)
            for (const k of interiorLines(this.plane, axis))
                if (this.isVirtual(axis, k))
                    n++;
        return n;
    }
    isSlicing(list = this.list) {
        return isSlicing(list, this.sliceMemo);
    }
    // ---- boundaries --------------------------------------------------------
    /** Set the px size every card in a slot declares. */
    declare(axis, slot, size) {
        const [lo] = SPAN[axis];
        for (const c of this.list) {
            if (c[lo] !== slot || fixedSize(c, axis) === null)
                continue;
            if (axis === 'x')
                c.width = size;
            else
                c.height = size;
        }
    }
    /** Whether every card meets its minimum at the current plane size. */
    fits(axis) {
        for (const w of this.extents(axis).values())
            if (w < this.min - EPS)
                return false;
        return true;
    }
    /**
     * Writes the widths in `want` to the sharing slots by moving the lines between
     * them. An entry of `null` leaves that slot to share the remainder in
     * proportion to its span.
     *
     * Slots with a px size are skipped: that size is the host's and `want` does
     * not override it. Only the lines around the named slots move.
     */
    setSlotWidths(axis, want) {
        const a = this.arr(axis);
        const count = a.length - 1;
        if (want.length !== count || this.size(axis) <= 0)
            return;
        const plane = this.plane;
        const read = linesRead(plane, axis);
        const held = heldSizes(plane, axis);
        const sizes = slotSizes(plane, axis);
        // Total width and span of the sharing slots. Both are read from the current
        // sizes, not from the normalised array being rewritten below.
        let room = 0;
        let span = 0;
        for (let i = 0; i < count; i++) {
            if (held[i] !== null)
                continue;
            room += sizes[i];
            span += a[i + 1] - a[i];
        }
        if (span < EPS || room < EPS)
            return;
        const size = new Array(count).fill(0);
        let named = 0;
        let open = 0;
        let nulls = 0;
        for (let i = 0; i < count; i++) {
            if (held[i] !== null)
                continue;
            if (want[i] === null) {
                open += a[i + 1] - a[i];
                nulls++;
            }
            else {
                size[i] = Math.max(0, want[i] + corridorOf(plane, axis, i, read));
                named += size[i];
            }
        }
        const left = Math.max(0, room - named);
        for (let i = 0; i < count; i++) {
            if (held[i] !== null || want[i] !== null)
                continue;
            size[i] = open > EPS ? (left * (a[i + 1] - a[i])) / open : left / nulls;
        }
        // Rewrite each sharing span in proportion to its new size, keeping the total
        // span unchanged so the lines outside this run do not move. `was` is a copy
        // because the loop writes into `a` as it advances.
        const total = named + left;
        if (total < EPS)
            return;
        const was = [...a];
        let at = a[0];
        for (let i = 0; i < count; i++) {
            at += held[i] !== null ? was[i + 1] - was[i] : (span * size[i]) / total;
            a[i + 1] = at;
        }
        a[count] = was[count];
    }
    /**
     * Applies `want`, letting one sharing slot absorb the difference.
     *
     * `order` lists the candidate slots, nearest the boundary first. Each is set
     * to `null` in turn, written, and measured; the first that keeps every card at
     * `minSize` is kept and the rest are restored. If none does, every sharing
     * slot is set to `null` and they share the difference.
     *
     * Measuring after writing means the sizes come from `slotSizes` and are not
     * predicted separately.
     *
     * Returns the slot that absorbed the difference, or -1.
     */
    settleOn(axis, want, order) {
        const held = heldSizes(this.plane, axis);
        const undo = this.toJSON();
        for (const slot of order) {
            if (slot < 0 || slot >= want.length || held[slot] !== null)
                continue;
            const had = want[slot];
            want[slot] = null;
            this.setSlotWidths(axis, want);
            if (this.fits(axis))
                return slot;
            this.restore(undo);
            want[slot] = had;
        }
        for (let i = 0; i < want.length; i++)
            if (held[i] === null)
                want[i] = null;
        this.setSlotWidths(axis, want);
        return -1;
    }
    /**
     * Sets one slot's px size and takes the difference from `pays`, the slot on
     * the other side of the boundary.
     *
     * A drag moves one boundary, so only those two slots change. Both indices come
     * from that boundary and are therefore in range and never equal.
     */
    resizeSlot(axis, slot, size, pays) {
        const width = slotWidths(this.plane, axis);
        const delta = size - width[slot];
        this.declare(axis, slot, size);
        const want = [...width];
        want[slot] = size;
        if (heldSizes(this.plane, axis)[pays] !== null) {
            // Both slots have a px size, so `pays` is reduced by the same amount.
            this.declare(axis, pays, Math.max(0, width[pays] - delta));
            this.setSlotWidths(axis, want);
            return;
        }
        want[pays] = null;
        this.setSlotWidths(axis, want);
    }
    /**
     * The card whose px size a drag at this boundary changes, if either slot
     * meeting there has one. Every card in that slot takes the new size.
     */
    holderAt(axis, line) {
        const [lo, hi] = SPAN[axis];
        const before = this.list.find((c) => c[hi] === line && fixedSize(c, axis) !== null);
        if (before)
            return before;
        return this.list.find((c) => c[lo] === line && fixedSize(c, axis) !== null);
    }
    /** Everything to draw for the boundaries. */
    rules() {
        return rules(this.plane);
    }
    dividers() {
        return dividers(this.plane, this.grabSize);
    }
    /** Where a boundary is now, in px along its axis. */
    boundaryPos(axis, line) {
        if (this.noAxis(axis) || !Number.isInteger(line))
            return 0;
        const along = linePositions(this.plane, axis);
        return line >= 0 && line < along.length ? along[line] : 0;
    }
    /** The nearest line on that side that at least one card references. */
    realNeighbour(axis, line, step) {
        const last = this.arr(axis).length - 1;
        let at = line + step;
        while (at > 0 && at < last && this.isVirtual(axis, at))
            at += step;
        return at;
    }
    /**
     * Whether `line` is an interior line index.
     *
     * Index 0 and the last index are the plane's borders and are not boundaries.
     */
    hasBoundary(axis, line) {
        if (this.noAxis(axis))
            return false;
        return Number.isInteger(line) && line >= 1 && line <= this.arr(axis).length - 2;
    }
    /**
     * The px range a boundary may move within while every card keeps `minSize`.
     *
     * The range extends to the nearest line a card references; unreferenced lines
     * do not limit it. When the cards on both sides need more than the plane
     * holds, `lo` and `hi` are equal rather than inverted.
     */
    boundaryRange(axis, line) {
        var _a, _b;
        if (this.noAxis(axis))
            return [0, 0];
        const along = linePositions(this.plane, axis);
        const [lo, hi] = SPAN[axis];
        // The neighbouring lines are hard limits. Past one of them the line array is
        // out of order and a card is drawn wider than one spanning more slots.
        const first = (_a = along[this.realNeighbour(axis, line, -1)]) !== null && _a !== void 0 ? _a : 0;
        const last = (_b = along[this.realNeighbour(axis, line, 1)]) !== null && _b !== void 0 ? _b : this.size(axis);
        let min = first;
        let max = last;
        const plane = this.plane;
        const read = linesRead(plane, axis); // one pass, not two per card
        for (const card of this.list) {
            const near = inset(plane, axis, card[lo], 'lo', read);
            const far = inset(plane, axis, card[hi], 'hi', read);
            if (card[hi] === line)
                min = Math.max(min, along[card[lo]] + this.min + near + far);
            if (card[lo] === line)
                max = Math.min(max, along[card[hi]] - this.min - near - far);
        }
        // The two cards can need more than the plane holds. Neither reaches its
        // minimum, so the range collapses to one point instead of inverting, which
        // every caller would otherwise have to check.
        if (min > max) {
            const mid = clamp((min + max) / 2, first, last);
            return [mid, mid];
        }
        return [min, max];
    }
    /**
     * Move a boundary to a position in px.
     *
     * When either adjacent slot has a px size, that size changes. Otherwise the
     * line itself moves and every card referencing it moves with it.
     *
     * Returns the resulting position.
     */
    moveBoundary(axis, line, px, allowSnap = true) {
        if (this.noAxis(axis))
            return 0;
        if (!this.hasBoundary(axis, line) || !Number.isFinite(px))
            return this.boundaryPos(axis, line);
        const [min, max] = this.boundaryRange(axis, line);
        let target = clamp(px, min, max);
        if (allowSnap && this.snap !== 'off') {
            const along = linePositions(this.plane, axis);
            for (const edge of [along[line - 1], along[line + 1]]) {
                if (edge >= min - EPS && edge <= max + EPS && Math.abs(target - edge) < this.snapDistance) {
                    target = edge;
                }
            }
        }
        // Remove the unreferenced lines the move has passed.
        line = this.forgetLinesPassed(axis, line, target);
        const holder = this.holderAt(axis, line);
        if (holder) {
            // Measure from the edge that does not move. Both positions are read before
            // the change is applied.
            const [lo, hi] = SPAN[axis];
            const along = linePositions(this.plane, axis);
            const slot = holder[hi] === line
                ? target - along[holder[lo]] // its far edge moved; its start is fixed
                : along[holder[hi]] - target; // its near edge moved; its end is fixed
            // `slot` is line to line, so subtract the gap to get the drawn size. A card
            // with a px size spans one slot; `changed` removes the size from a card
            // that comes to span more.
            const size = Math.max(0, slot - corridorOf(this.plane, axis, holder[lo]));
            // The slot on the other side of the boundary absorbs the difference.
            this.resizeSlot(axis, holder[lo], size, holder[hi] === line ? line : line - 1);
        }
        else {
            const usable = this.sharedExtent(axis);
            const before = linePositions(this.plane, axis)[line - 1];
            const a = this.arr(axis);
            // Only the sharing slots hold normalised width, so convert against those.
            const want = usable > EPS ? a[line - 1] + (target - before) / usable : a[line - 1];
            // The conversion uses one average px-per-unit ratio, which the slots do not
            // all follow once a px size exists, so the result can land past a
            // neighbouring line. That would put the array out of order and draw a card
            // wider than one spanning more slots.
            a[line] = clamp(want, a[line - 1], a[line + 1]);
        }
        this.changed();
        return this.boundaryPos(axis, line);
    }
    /**
     * Removes the unreferenced lines the move passes and returns the new index of
     * the moved line.
     *
     * Leaving a passed line in place would put the array out of order.
     */
    forgetLinesPassed(axis, line, target) {
        const a = this.arr(axis);
        // No card references these lines, so it does not matter which neighbour absorbs them.
        const drop = (k) => this.removeLine(axis, k, 'lo');
        // `target` is in px and the line array is normalised, so compare in px.
        const at = (k) => linePositions(this.plane, axis)[k];
        while (line - 1 >= 1 && this.isVirtual(axis, line - 1) && target < at(line - 1)) {
            drop(line - 1);
            line--;
        }
        while (line + 1 <= a.length - 2 && this.isVirtual(axis, line + 1) && target > at(line + 1)) {
            drop(line + 1);
        }
        if (a !== this.arr(axis))
            this.changed();
        return line;
    }
    /** px per unit of normalised span across the sharing slots. */
    sharedExtent(axis) {
        const a = this.arr(axis);
        const sizes = slotSizes(this.plane, axis);
        const held = heldSizes(this.plane, axis);
        let px = 0;
        let span = 0;
        for (let i = 0; i < sizes.length; i++) {
            if (held[i] !== null)
                continue;
            px += sizes[i];
            span += a[i + 1] - a[i];
        }
        return span > EPS ? px / span : 0;
    }
    /**
     * Moves a boundary so the two cards beside it are drawn at the same size.
     *
     * This is not the midpoint of the two lines: a card at the plane's border
     * insets on one side only.
     */
    centerBoundary(axis, line) {
        var _a, _b;
        if (this.noAxis(axis))
            return 0;
        if (!this.hasBoundary(axis, line))
            return this.boundaryPos(axis, line);
        const along = linePositions(this.plane, axis);
        const [lo, hi] = SPAN[axis];
        let start = (_a = along[line - 1]) !== null && _a !== void 0 ? _a : 0;
        let end = (_b = along[line + 1]) !== null && _b !== void 0 ? _b : this.size(axis);
        const near = this.plane;
        const seen = linesRead(near, axis);
        let insStart = inset(near, axis, line - 1, 'lo', seen);
        let insEnd = inset(near, axis, line + 1, 'hi', seen);
        for (const card of this.list) {
            if (card[hi] === line && along[card[lo]] >= start) {
                start = along[card[lo]];
                insStart = inset(near, axis, card[lo], 'lo', seen);
            }
            if (card[lo] === line && along[card[hi]] <= end) {
                end = along[card[hi]];
                insEnd = inset(near, axis, card[hi], 'hi', seen);
            }
        }
        return this.moveBoundary(axis, line, (start + end) / 2 + (insStart - insEnd) / 2, false);
    }
    /**
     * Merges a line onto a neighbour at the same coordinate.
     *
     * Returns false when a card spans both lines, which would leave it zero size.
     */
    mergeCoincident(axis, line) {
        if (this.noAxis(axis))
            return false;
        if (this.snap === 'off')
            return false;
        const a = this.arr(axis);
        const [lo, hi] = SPAN[axis];
        const found = [line - 1, line + 1].find((i) => i >= 0 && i < a.length && Math.abs(a[i] - a[line]) < EPS);
        if (found === undefined)
            return false;
        // Index 0 and the last index hold exactly 0 and 1. When one of the pair is a
        // border it is the one kept: removing it promoted a coordinate one rounding
        // short of the edge and the plane measured 0.9999999999999999 wide.
        const border = (i) => i === 0 || i === a.length - 1;
        const [keep, drop] = border(line) ? [line, found] : [found, line];
        const at = (card, k) => (card[k] === drop ? keep : card[k]);
        if (this.list.some((c) => at(c, lo) === at(c, hi)))
            return false;
        for (const card of this.list) {
            card[lo] = at(card, lo);
            card[hi] = at(card, hi);
        }
        // Every card now references `keep`, so it does not matter which neighbour
        // absorbs the removed line.
        this.removeLine(axis, drop, 'lo');
        this.changed();
        return true;
    }
    /** Removes lines no card references. Returns how many were removed. */
    tidy() {
        let dropped = 0;
        for (const axis of AXES) {
            for (let k = this.arr(axis).length - 2; k >= 1; k--) {
                if (!this.isVirtual(axis, k))
                    continue;
                // No card references the line, so it does not matter which neighbour absorbs it.
                this.removeLine(axis, k, 'lo');
                dropped++;
            }
        }
        if (dropped)
            this.changed();
        return dropped;
    }
    // ---- splitting ---------------------------------------------------------
    /**
     * Returns the position to cut a card at.
     *
     * Prefers the unreferenced line nearest the card's centre that leaves both
     * halves at `minSize`. Otherwise returns a new line at the centre, clamped to
     * the range where both halves fit.
     */
    cutAt(card, axis) {
        if (card.fixed)
            return null;
        const a = this.arr(axis);
        const [lo, hi] = SPAN[axis];
        // px per unit of span: the card's own px size, or the sharing slots' ratio.
        const own = fixedSize(card, axis);
        const per = own !== null ? own / (a[card[hi]] - a[card[lo]] || 1) : this.sharedExtent(axis);
        if (per <= EPS)
            return null;
        const half = halfCorridor(this.plane, axis);
        const lowest = a[card[lo]] + (this.min + inset(this.plane, axis, card[lo], 'lo') + half) / per;
        const highest = a[card[hi]] - (this.min + half + inset(this.plane, axis, card[hi], 'hi')) / per;
        if (lowest > highest)
            return null;
        const mid = (a[card[lo]] + a[card[hi]]) / 2;
        let line = -1;
        for (let i = card[lo] + 1; i < card[hi]; i++) {
            if (a[i] < lowest || a[i] > highest)
                continue;
            if (line < 0 || Math.abs(a[i] - mid) < Math.abs(a[line] - mid))
                line = i;
        }
        if (line >= 0)
            return { line, value: a[line] };
        return { line: -1, value: clamp(mid, lowest, highest) };
    }
    /** The smallest drawn side of every card, by id. Used to compare before and after a change. */
    extents(axis) {
        const out = new Map();
        for (const [id, r] of this.rects())
            out.set(id, axis === 'x' ? r.w : r.h);
        return out;
    }
    /** Whether every card is drawn with a non-zero width and height. */
    hasArea() {
        const frame = frameOf(this.plane);
        return this.list.every((c) => {
            const r = rectIn(frame, c);
            return r.w > 0 && r.h > 0;
        });
    }
    /**
     * Whether every card still has the smaller of the size it had and `minSize`.
     *
     * A new line adds a gap, taken from the sharing slots, so a split can reduce a
     * card elsewhere on the plane.
     */
    stillFits(axis, before) {
        // Every card must have a non-zero area, including one just created.
        if (!this.hasArea())
            return false;
        for (const [id, now] of this.extents(axis)) {
            // `minSize` applies only to cards present before the change. A new card
            // has the size it was given, and `cutAt` checks the halves of a cut.
            const was = before.get(id);
            if (was === undefined)
                continue;
            if (now < Math.min(this.min, was) - 0.01)
                return false;
        }
        return true;
    }
    /** True when the cut leaves every card the smaller of its current size and `minSize`. */
    canSplit(id, axis) {
        if (this.noAxis(axis))
            return false;
        // canSplit performs a trial split, copying the state twice. The result is
        // cached until the next change, because a host redraw calls this once per
        // card per axis: 134 calls at 67 cards.
        const key = `split:${id}:${axis}`;
        const known = this.splitMemo.get(key);
        if (known !== undefined)
            return known;
        const card = this.find(id);
        let ok = false;
        if (card && this.cutAt(card, axis)) {
            const before = this.toJSON();
            const seq = this.seq; // a trial must not consume an id
            this.probing = true;
            ok = this.split(id, axis) !== null;
            this.restore(before);
            this.probing = false;
            this.seq = seq;
        }
        this.splitMemo.set(key, ok);
        return ok;
    }
    /**
     * Cut one card in two.
     *
     * The original keeps its id and the near half; the new card takes the far
     * half. Cards spanning the new line have their span widened rather than cut.
     *
     * The new card has no `data` unless `init.data` is given. A px size on the
     * other axis is copied, because both halves stay in that slot. A px size on
     * the cut axis is divided between them.
     *
     * Returns the new card's id, or null when the halves do not fit.
     */
    split(id, axis, init = {}) {
        var _a;
        if (this.noAxis(axis))
            return null;
        // An id already in use would give two cards the same key. `rects` and the
        // view are both keyed by id, so one card would have no rect and no element.
        if (init.id !== undefined && this.find(init.id))
            return null;
        const card = this.find(id);
        const cut = card && this.cutAt(card, axis);
        if (!card || !cut)
            return null;
        const was = this.extents(axis);
        const undo = this.toJSON();
        const a = this.arr(axis);
        const [lo, hi] = SPAN[axis];
        // Read before the cut, because the new line makes the card span two slots.
        const whole = fixedSize(card, axis);
        const from = a[card[lo]];
        const to = a[card[hi]];
        let line = cut.line;
        if (line < 0) {
            // The new line is placed strictly inside the card's span.
            line = card[lo] + 1;
            while (line < card[hi] && a[line] <= cut.value + EPS)
                line++;
            // The line is inside a card rather than at a boundary, so every span at or
            // past this index shifts by one, including a card that ends here.
            a.splice(line, 0, cut.value);
            for (const other of this.list) {
                if (other[lo] >= line)
                    other[lo]++;
                if (other[hi] >= line)
                    other[hi]++;
            }
        }
        const fresh = {
            id: (_a = init.id) !== null && _a !== void 0 ? _a : this.nextId(),
            c0: card.c0,
            c1: card.c1,
            r0: card.r0,
            r1: card.r1,
            fixed: false,
            data: init.data,
        };
        // A px size on the other axis is copied, because both halves stay in that slot.
        const across = other(axis);
        const alongside = fixedSize(card, across);
        if (alongside !== null) {
            if (across === 'x')
                fresh.width = alongside;
            else
                fresh.height = alongside;
        }
        // A px size on the cut axis is divided in the proportion of the cut.
        if (whole !== null) {
            const f = to - from > EPS ? (a[line] - from) / (to - from) : 0.5;
            if (axis === 'x') {
                card.width = whole * f;
                fresh.width = whole * (1 - f);
            }
            else {
                card.height = whole * f;
                fresh.height = whole * (1 - f);
            }
        }
        fresh[lo] = line;
        card[hi] = line;
        this.list.push(fresh);
        this.paidBy.set(fresh.id, { side: 'lo', to: card.id });
        this.changed();
        if (!this.stillFits(axis, was)) {
            this.restore(undo);
            return null;
        }
        return fresh.id;
    }
    /**
     * Cut a card and put the new one on a named side.
     *
     * `split` gives the far half to the new card, so `left` and `top` swap the two
     * spans afterwards. The ids are not swapped.
     */
    splitToward(id, side, init = {}) {
        // axisOf returns 'y' for any value that is not left or right, so a misspelled
        // side would split downward instead of failing.
        if (!SIDES.includes(side))
            return null;
        if (init.id !== undefined && this.find(init.id))
            return null;
        const axis = axisOf(side);
        const card = this.find(id);
        if (!card)
            return null;
        if (!isAhead(side))
            return this.split(id, axis, init);
        const born = this.split(id, axis, init);
        if (born === null)
            return null;
        const fresh = this.find(born);
        const [lo, hi] = SPAN[axis];
        const near = [card[lo], card[hi]];
        card[lo] = fresh[lo];
        card[hi] = fresh[hi];
        fresh[lo] = near[0];
        fresh[hi] = near[1];
        this.paidBy.set(fresh.id, { side: 'hi', to: card.id }); // the halves were swapped
        this.changed();
        return born;
    }
    nextId() {
        let id;
        do {
            id = `card-${++this.seq}`;
        } while (this.find(id));
        return id;
    }
    // ---- closing and moving ------------------------------------------------
    /**
     * The neighbours that would expand over a card if it closed, as frozen copies.
     *
     * Returns null when no row of neighbours matches a side. `close` then removes
     * the card's slots instead.
     */
    fill(id) {
        const found = this.fillOf(id);
        return found && { ...found, cards: found.cards.map((c) => Object.freeze({ ...c })) };
    }
    /** The same result holding the stored cards, so `close` can modify them. */
    fillOf(id) {
        const card = this.find(id);
        return card ? fillFor(this.list, card, this.order, this.sliceMemo) : null;
    }
    /**
     * The axis whose slots hold no other card, or null.
     *
     * On that axis the card's slots can be removed when it closes, with no
     * neighbour expanding over it. Returns null when another card lies entirely
     * inside the range, because removing the slots would leave it spanning nothing.
     */
    soleSlots(card) {
        for (const axis of AXES) {
            const [lo, hi] = SPAN[axis];
            // Removing the slots shrinks every card that reaches into them, and leaves
            // a card lying entirely inside the range with no span.
            const trapped = this.list.some((other) => other !== card && other[lo] >= card[lo] && other[hi] <= card[hi]);
            if (!trapped)
                return axis;
        }
        return null;
    }
    removable(id) {
        const card = this.find(id);
        if (!card || card.fixed)
            return null;
        if (this.list.filter((c) => !c.fixed).length <= 1)
            return null;
        return card;
    }
    canClose(id) {
        const card = this.removable(id);
        return !!card && (!!this.fillOf(id) || this.soleSlots(card) !== null);
    }
    /**
     * Remove a card.
     *
     * A row of neighbours expands over the space when one matches the side.
     * Otherwise the card's slots are removed. Returns false when neither applies,
     * when the card is `fixed`, or when it is the last card.
     */
    close(id) {
        const card = this.removable(id);
        if (!card)
            return false;
        // Return the span by removing the line on the side it came from. Only valid
        // when no other card is in these slots.
        const paid = this.paidBy.get(id);
        if (paid) {
            for (const axis of AXES) {
                const [lo, hi] = SPAN[axis];
                if (card[hi] - card[lo] !== 1)
                    continue;
                const alone = this.list.every((c) => c === card || c[hi] <= card[lo] || c[lo] >= card[hi]);
                if (!alone)
                    continue;
                const gone = paid.side === 'lo' ? card[lo] : card[hi];
                if (gone <= 0 || gone >= this.arr(axis).length - 1)
                    continue;
                // Removing the line expands every card that ends or starts on it. Only
                // the card that gave the span up should expand, so this path runs only
                // when it is the sole other card referencing the line.
                const reading = this.list.filter((c) => c !== card && (c[lo] === gone || c[hi] === gone));
                if (reading.length !== 1)
                    continue;
                const held = slotWidths(this.plane, axis);
                const mine = card[lo];
                this.list.splice(this.list.indexOf(card), 1);
                this.removeLine(axis, gone, paid.side);
                this.paidBy.delete(id);
                // The card's slot is removed. The slot it merges into keeps its width and
                // the slot that gave the span up regains it. No other slot changes.
                const back = this.find(paid.to);
                const want = held.filter((_, i) => i !== mine);
                const merged = paid.side === 'lo' ? mine - 1 : mine;
                this.settleOn(axis, want, order(back ? back[lo] : merged, want.length));
                this.changed();
                return true;
            }
        }
        const filling = this.fillOf(id);
        if (filling) {
            const axis = filling.grow === 'c0' || filling.grow === 'c1' ? 'x' : 'y';
            // A line's position does not depend on which cards reference it. Closing
            // the card leaves its line unreferenced, and R5 gives an unreferenced line
            // no gap, which changes the drawn width of the cards beside it but not the
            // line's position. Record the positions first and restore the lines that
            // moved only because they became unreferenced.
            const stood = this.arr(axis).map((_, k) => this.boundaryPos(axis, k));
            const [lo, hi] = SPAN[axis];
            const from = card[lo];
            const to = card[hi];
            const want = slotWidths(this.plane, axis);
            for (const neighbour of filling.cards)
                neighbour[filling.grow] = card[filling.grow];
            this.list.splice(this.list.indexOf(card), 1);
            // The card's slots go to the neighbour that expanded over them. Every other
            // slot keeps its width.
            this.settleOn(axis, want, order(from, want.length, to - 1));
            this.standAgain(axis, stood);
            this.changed();
            return true;
        }
        const axis = this.soleSlots(card);
        if (axis === null)
            return false;
        const [lo, hi] = SPAN[axis];
        const from = card[lo];
        const count = card[hi] - from;
        const held = slotWidths(this.plane, axis);
        this.list.splice(this.list.indexOf(card), 1);
        for (let i = 0; i < count; i++)
            this.dropSlot(axis, from);
        // The slots are removed and the neighbour that absorbed them takes the space.
        const kept = held.filter((_, i) => i < from || i >= from + count);
        this.settleOn(axis, kept, order(Math.min(from, kept.length - 1), kept.length));
        this.changed();
        return true;
    }
    /**
     * Restores unreferenced lines to their previous px positions.
     *
     * The coordinate that produces a given px position has no closed form, because
     * a slot's size depends on every other slot. It is found by iteration: each
     * pass moves the coordinate by the error divided by the slope, and the error
     * falls fast enough that a few passes reach it exactly.
     */
    standAgain(axis, stood) {
        const a = this.arr(axis);
        for (let k = 1; k < a.length - 1; k++) {
            const want = stood[k];
            if (want === undefined || !this.isVirtual(axis, k))
                continue;
            for (let pass = 0; pass < 8; pass++) {
                const at = this.boundaryPos(axis, k);
                const off = want - at;
                if (Math.abs(off) < 1e-9)
                    break;
                const span = a[k + 1] - a[k - 1];
                const room = this.boundaryPos(axis, k + 1) - this.boundaryPos(axis, k - 1);
                if (span < EPS || room < EPS)
                    break;
                const next = a[k] + (off * span) / room;
                if (!(next > a[k - 1] && next < a[k + 1]))
                    break; // no room to stand there
                a[k] = next;
            }
        }
    }
    /**
     * Whether a card spanning the whole plane can be placed on this boundary.
     *
     * True when no card spans across the line. `without` excludes one card by id.
     */
    canInsertAt(axis, line, without) {
        if (this.noAxis(axis))
            return false;
        const a = this.arr(axis);
        if (!Number.isInteger(line) || line < 0 || line > a.length - 1)
            return false;
        return this.cardsCrossing(axis, line).every((c) => c.id === without);
    }
    /**
     * Inserts a card at a boundary, spanning the whole plane on the other axis.
     *
     * Unlike `splitToward`, the new card is not cut from one card. Cards past the
     * boundary shift by one index.
     *
     * `size` is required, in px, and must be smaller than the plane. It is
     * converted to a span in proportion to the plane.
     *
     * Returns the new card's id, or null when a card spans the boundary, the size
     * is invalid, or the result would leave a card with no area.
     */
    insertAt(axis, line, init) {
        var _a;
        if (this.noAxis(axis))
            return null;
        if ((init === null || init === void 0 ? void 0 : init.id) !== undefined && this.find(init.id))
            return null;
        const plane = this.size(axis);
        // A size equal to the plane leaves the existing cards none, and `openSlot`
        // would write the new line before the plane's start. Rejected here rather
        // than detected afterwards by measuring the result.
        if (!Number.isFinite(init === null || init === void 0 ? void 0 : init.size) || init.size < 0 || init.size >= plane)
            return null;
        if (!this.canInsertAt(axis, line))
            return null;
        const was = this.extents(axis);
        const undo = this.toJSON();
        const [lo, hi] = SPAN[axis];
        const across = other(axis);
        const [alo, ahi] = SPAN[across];
        const held = slotWidths(this.plane, axis);
        this.openSlot(axis, line, init.size / plane);
        const fresh = {
            id: (_a = init.id) !== null && _a !== void 0 ? _a : this.nextId(),
            c0: 0, c1: 1, r0: 0, r1: 1,
            fixed: false,
            data: init.data,
        };
        fresh[lo] = line;
        fresh[hi] = line + 1;
        fresh[alo] = 0;
        fresh[ahi] = this.arr(across).length - 1;
        if (axis === 'x')
            fresh.width = init.size;
        else
            fresh.height = init.size;
        this.list.push(fresh);
        // The slot next to the new one gives up the space, so a close at the same
        // boundary returns it directly. Every other slot keeps its width.
        const want = new Array(this.arr(axis).length - 1).fill(0);
        for (let i = 0; i < held.length; i++)
            want[i >= line ? i + 1 : i] = held[i];
        want[line] = init.size;
        const pays = this.settleOn(axis, want, order(line + 1, want.length, line - 1));
        // Record which slot gave up the space, not only the side: the nearest slot
        // may not have had room, and close returns the space to the recorded slot.
        const payer = pays >= 0 ? this.list.find((c) => c[lo] === pays && c !== fresh) : undefined;
        if (payer)
            this.paidBy.set(fresh.id, { side: pays > line ? 'hi' : 'lo', to: payer.id });
        this.changed();
        if (!this.stillFits(axis, was)) {
            this.restore(undo);
            return null;
        }
        return fresh.id;
    }
    /** Whether a card occupies one slot on one axis and spans the whole other axis. */
    spansPlane(card, axis) {
        const [lo, hi] = SPAN[axis];
        const across = other(axis);
        const [alo, ahi] = SPAN[across];
        return (card[hi] - card[lo] === 1 &&
            card[alo] === 0 &&
            card[ahi] === this.arr(across).length - 1);
    }
    /**
     * Insert a slot at a boundary with the given span.
     *
     * Every other slot is scaled by `1 - span`. A card ending at the boundary
     * keeps its index and a card starting there shifts by one.
     */
    openSlot(axis, line, span) {
        const a = this.arr(axis);
        // The new slot takes its span from the slot next to the boundary, so a close
        // that merges it back restores the previous spans. Which of the two slots is
        // used depends on which has room.
        const after = line < a.length - 1 ? a[line + 1] - a[line] : 0;
        const before = line > 0 ? a[line] - a[line - 1] : 0;
        if (after >= span) {
            a.splice(line + 1, 0, a[line] + span);
        }
        else if (before >= span) {
            const at = a[line];
            a[line] = at - span;
            a.splice(line + 1, 0, at);
        }
        else {
            // Neither neighbour has enough room alone, so take the span from the whole plane.
            const keep = 1 - span;
            const at = a[line] * keep + span;
            for (let k = 0; k < a.length; k++)
                a[k] = k <= line ? a[k] * keep : a[k] * keep + span;
            a.splice(line + 1, 0, at);
            a[a.length - 1] = 1;
        }
        this.openIndex(axis, line);
    }
    /**
     * Open a slot at a boundary and shift the spans that referenced it.
     *
     * A card that starts on the line moves past the new slot; a card that ends on
     * it keeps its index. `removeLine(axis, line, 'hi')` is the inverse.
     */
    openIndex(axis, line) {
        const [lo, hi] = SPAN[axis];
        for (const card of this.list) {
            if (card[lo] >= line)
                card[lo]++;
            if (card[hi] > line)
                card[hi]++;
        }
    }
    /**
     * Remove one line and shift the spans that referenced it.
     *
     * `into` selects which neighbouring slot absorbs the removed one, which decides
     * whether a card ending on the line follows it or extends past it.
     */
    removeLine(axis, gone, into) {
        const a = this.arr(axis);
        const [lo, hi] = SPAN[axis];
        a.splice(gone, 1);
        for (const card of this.list) {
            if (card[lo] >= gone)
                card[lo]--;
            if (into === 'lo' ? card[hi] > gone : card[hi] >= gone)
                card[hi]--;
        }
    }
    /**
     * Remove one slot by removing a line beside it.
     *
     * Removes the far line, or the near one for the last slot, so the plane's two
     * borders are never removed.
     */
    dropSlot(axis, slot) {
        const a = this.arr(axis);
        if (a.length <= 2)
            return; // one slot, no interior line, nothing to take
        // Remove the interior line: the far one, or the near one for the last slot,
        // so the plane's two borders are never removed. The slot on the other side
        // of that line absorbs the removed one.
        const last = slot + 1 >= a.length - 1;
        this.removeLine(axis, last ? slot : slot + 1, last ? 'lo' : 'hi');
    }
    /**
     * Move a plane-spanning card to another boundary.
     *
     * The card's slot is removed and a slot of the same span is inserted at the
     * target. No other card's spans change and no line on the other axis moves.
     *
     * `line` is an index in the current arrangement.
     */
    moveTo(id, axis, line) {
        if (this.noAxis(axis))
            return false;
        const card = this.find(id);
        // `fixed` blocks the layout, not a direct call from the host. This operation
        // changes no other card's spans, so a fixed card may be moved.
        if (!card || !this.spansPlane(card, axis))
            return false;
        const [lo, hi] = SPAN[axis];
        const from = card[lo];
        if (line === from || line === card[hi])
            return true; // already there
        const before = this.toJSON();
        const a = this.arr(axis);
        const was = [...a];
        const span = was[from + 1] - was[from];
        this.list.splice(this.list.indexOf(card), 1);
        // The same slot is reinserted rather than given to one neighbour and taken
        // from another. The indices move first, because canInsertAt reads only those.
        // The card is out of the list, so the slot after it absorbs the line.
        this.removeLine(axis, from + 1, 'hi');
        // The target index shifts down by one when it was past the removed slot.
        const target = line > from + 1 ? line - 1 : line;
        if (!this.canInsertAt(axis, target)) {
            this.restore(before);
            return false;
        }
        a.splice(target, 0, 0);
        this.openIndex(axis, target);
        // Each coordinate is written from its previous value. The lines the slot
        // passes shift by its span once and the rest keep their exact value.
        // Shifting the whole tail out and back added a rounding error to every line.
        if (target <= from) {
            for (let k = 0; k <= target; k++)
                a[k] = was[k];
            for (let k = target + 1; k <= from + 1; k++)
                a[k] = was[k - 1] + span;
            for (let k = from + 2; k < a.length; k++)
                a[k] = was[k];
        }
        else {
            for (let k = 0; k <= from; k++)
                a[k] = was[k];
            for (let k = from + 1; k < target; k++)
                a[k] = was[k + 1] - span;
            a[target] = was[line] - span;
            for (let k = target + 1; k < a.length; k++)
                a[k] = was[k];
        }
        const across = other(axis);
        const [alo, ahi] = SPAN[across];
        card[lo] = target;
        card[hi] = target + 1;
        card[alo] = 0;
        card[ahi] = this.arr(across).length - 1;
        this.list.push(card);
        this.changed();
        // The slot leaves one boundary and arrives at another, so the neighbours that
        // give and take the span are different. Reject the move when the result
        // leaves a card with no area.
        if (!this.hasArea()) {
            this.restore(before);
            return false;
        }
        return true;
    }
    /**
     * Every boundary a plane-spanning card could stand on.
     *
     * `without` excludes one card by id, so a card already placed can query the
     * other boundaries without blocking itself.
     */
    standings(axis, without) {
        if (this.noAxis(axis))
            return [];
        // Includes the plane's two borders, which `insertAt` accepts.
        const out = [];
        for (let k = 0; k < this.arr(axis).length; k++) {
            if (this.canInsertAt(axis, k, without))
                out.push(k);
        }
        return out;
    }
    /**
     * Moves a card to one side of another. This is the drag-and-drop operation.
     *
     * One operation rather than a close and a split sequenced by the caller,
     * because the order matters: the close returns the space first and changes the
     * target's geometry, so the cut is measured after it. A close that cannot
     * happen leaves the arrangement unchanged instead of half changed.
     *
     * The card keeps its id and its payload, so the host's element is reused and a
     * live surface inside it is not destroyed. It keeps its px size only when it
     * lands spanning one slot on that axis.
     */
    move(id, targetId, side) {
        // `splitToward` below rejects an invalid side and the close before it is
        // rolled back, so no check is needed here.
        const card = this.find(id);
        const target = this.find(targetId);
        if (!card || !target || card === target || card.fixed)
            return false;
        const carried = { data: card.data, width: card.width, height: card.height };
        const before = this.toJSON();
        if (!this.close(id))
            return false;
        const landed = this.splitToward(targetId, side, { id, data: carried.data });
        if (landed === null) {
            this.restore(before);
            return false;
        }
        const moved = this.find(landed);
        // The px size is the card's. Which of the two applies depends on the axis it lands on.
        if (axisOf(side) === 'x') {
            if (carried.width !== undefined)
                moved.width = carried.width;
            if (carried.height !== undefined && spanOf(moved, 'y') === 1)
                moved.height = carried.height;
        }
        else {
            if (carried.height !== undefined)
                moved.height = carried.height;
            if (carried.width !== undefined && spanOf(moved, 'x') === 1)
                moved.width = carried.width;
        }
        this.changed();
        return true;
    }
    /** Whether `move` would succeed, without performing it. */
    canMove(id, targetId, side) {
        // Performs the move, records the result and restores the state, as canSplit
        // does, and caches it alongside. Building a second Soksak copied the whole
        // arrangement and every option per call, and a host queries four sides on
        // every pointer move.
        const key = `move:${id}:${targetId}:${side}`;
        const known = this.splitMemo.get(key);
        if (known !== undefined)
            return known;
        const before = this.toJSON();
        const seq = this.seq;
        const probing = this.probing;
        this.probing = true;
        const ok = this.move(id, targetId, side);
        this.restore(before);
        this.probing = probing;
        this.seq = seq;
        this.splitMemo.set(key, ok);
        return ok;
    }
    /**
     * Runs after every operation that changes the arrangement.
     *
     * A px size describes one slot, so a card that comes to span two loses it. The
     * value is removed rather than kept for a later split to reapply.
     */
    changed() {
        // A trial split discards its state, so it must not clear the cache.
        if (!this.probing)
            this.splitMemo.clear();
        this.agreeSizes();
        this.sliceMemo.clear();
    }
    /**
     * Writes the largest declared px size to every card in a slot, and removes the
     * size from a card that no longer spans one slot.
     *
     * A slot has one width, so two cards in it cannot declare different sizes.
     * `heldSizes` reads the largest and this writes it back, so `toJSON` reports
     * what is drawn. Called wherever cards are added or moved.
     */
    agreeSizes() {
        // A closed card has nothing to return the span to, and a rolled-back trial
        // operation leaves an entry for an id that no longer exists.
        if (this.paidBy.size) {
            const live = new Set(this.list.map((c) => c.id));
            for (const id of this.paidBy.keys())
                if (!live.has(id))
                    this.paidBy.delete(id);
        }
        for (const card of this.list) {
            if (card.width !== undefined && card.c1 - card.c0 !== 1)
                delete card.width;
            if (card.height !== undefined && card.r1 - card.r0 !== 1)
                delete card.height;
        }
        for (const axis of AXES) {
            const [lo] = SPAN[axis];
            const agreed = heldSizes(this.plane, axis);
            for (const card of this.list) {
                if (fixedSize(card, axis) === null)
                    continue;
                const size = agreed[card[lo]];
                if (axis === 'x')
                    card.width = size;
                else
                    card.height = size;
            }
        }
    }
    /** Restores the arrangement to a state returned earlier by `toJSON`. */
    restore(state) {
        var _a;
        this.xs = [...state.xs];
        this.ys = [...state.ys];
        this.list = state.cards.map((c) => { var _a; return ({ ...c, fixed: (_a = c.fixed) !== null && _a !== void 0 ? _a : false }); });
        this.paidBy = new Map(Object.entries((_a = state.paidBy) !== null && _a !== void 0 ? _a : {}));
        this.agreeSizes();
        this.sliceMemo.clear();
        if (!this.probing)
            this.splitMemo.clear();
    }
}
