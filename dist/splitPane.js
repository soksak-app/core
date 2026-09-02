/**
 * A soksak over shared grid lines.
 *
 * `xs` and `ys` hold every coordinate as a fraction of the plane. A card is a
 * span of indices into them, so two cards that meet read the same index and
 * their shared boundary is one number. Moving a line moves every card that
 * references it; a card spanning across the line is unaffected.
 *
 * Splitting replaces one card with two, so the arrangement stays a slicing
 * floorplan and every card can be closed.
 *
 * This module holds the state and the operations. `geometry.ts` computes the
 * coordinates.
 */
import { AXES, SPAN, axisOf, fixedSize, isAhead, other, spanOf } from './card.js';
import { corridorOf, crossing, dividers, frameOf, halfCorridor, heldSizes, inset, interiorLines, isVirtual, linePositions, rectIn, rectOf, rules, slotSizes, slotWidths, zoneAt, } from './geometry.js';
import { fillFor, isSlicing } from './slicing.js';
const SIDES = ['left', 'right', 'top', 'bottom'];
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
const clamp = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
export class Soksak {
    /** Corridor between two cards, in px. Never negative — a card would overlap. */
    get gap() {
        return this.g;
    }
    set gap(px) {
        if (!Number.isFinite(px) || px < 0)
            return;
        this.g = px;
        this.splitMemo.clear();
    }
    /** The smallest a card may be drawn on either axis. */
    get minSize() {
        return this.min;
    }
    /** Writing it clears the cached answers that were computed against the old one. */
    set minSize(px) {
        if (!Number.isFinite(px) || px < 0)
            return;
        this.min = px;
        this.splitMemo.clear();
    }
    /** Which axis a close tries first. */
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
    /** Without a state, starts as one card filling the plane. */
    constructor(state, options = {}) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        this.seq = 0;
        this.sliceMemo = new Map();
        this.splitMemo = new Map();
        /**
         * Which side of a card's slot gave up the span it occupies, by card id.
         *
         * `split` and `insertAt` take the span from one neighbour. A close returns it
         * by removing the line on that side, so the two are inverses. Without this
         * the space moves to whichever neighbour the fill picks, and repeating the
         * pair drives one card to `minSize`.
         */
        this.paidBy = new Map();
        /** Which side `openSlot` last took its span from. */
        /** True while canSplit runs a trial split and restores the state. */
        this.probing = false;
        this.g = 24;
        this.gap = (_a = options.gap) !== null && _a !== void 0 ? _a : 24;
        const min = (_b = options.minSize) !== null && _b !== void 0 ? _b : 96;
        this.min = Number.isFinite(min) && min >= 0 ? min : 96;
        this.grabSize = (_c = options.grabSize) !== null && _c !== void 0 ? _c : 11;
        this.snapDistance = (_d = options.snapDistance) !== null && _d !== void 0 ? _d : 7;
        this.snap = (_e = options.snap) !== null && _e !== void 0 ? _e : 'merge';
        this.order = (_f = options.fillOrder) !== null && _f !== void 0 ? _f : 'v';
        this.w = (_g = options.width) !== null && _g !== void 0 ? _g : 0;
        this.h = (_h = options.height) !== null && _h !== void 0 ? _h : 0;
        if (state) {
            this.xs = [...state.xs];
            this.ys = [...state.ys];
            this.list = state.cards.map((c) => { var _a; return ({ ...c, fixed: (_a = c.fixed) !== null && _a !== void 0 ? _a : false }); });
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
     * Writes to the returned objects do not reach the grid. Use `setFixed`,
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
        return true;
    }
    /**
     * Set a card's px width or height, or `null` for a share of what is left.
     *
     * Applies to a card spanning one slot on that axis. Sets the slot, so every
     * card in it takes the same size. Returns false when the axis or size is
     * invalid or the card spans more than one slot.
     */
    setSize(id, axis, px) {
        if (axis !== 'x' && axis !== 'y')
            return false;
        const card = this.find(id);
        if (!card)
            return false;
        if (px !== null && (!Number.isFinite(px) || px < 0 || spanOf(card, axis) !== 1))
            return false;
        // A slot has one size, so set it on every card in the slot.
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
        return [...(axis === 'x' ? this.xs : this.ys)];
    }
    toJSON() {
        return {
            xs: [...this.xs],
            ys: [...this.ys],
            cards: this.list.map((c) => ({ ...c })),
        };
    }
    get plane() {
        return { xs: this.xs, ys: this.ys, cards: this.list, width: this.w, height: this.h, gap: this.gap, minSize: this.min };
    }
    arr(axis) {
        return axis === 'x' ? this.xs : this.ys;
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
        return crossing(this.plane, axis, line).map((c) => Object.freeze({ ...c }));
    }
    /** How many lines a card spans across — how much finer its neighbours are. */
    crossings(card) {
        return Math.max(0, card.c1 - card.c0 - 1) + Math.max(0, card.r1 - card.r0 - 1);
    }
    /** True when no card reads this line — it survives only as a snap target. */
    isVirtual(axis, line) {
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
    /** Whether every card has its minimum, as the plane stands. */
    fits(axis) {
        for (const w of this.extents(axis).values())
            if (w < this.min - EPS)
                return false;
        return true;
    }
    /**
     * Give each sharing slot the width `want` names for it. A slot named `null`
     * takes what is left over, shared with the other `null` slots in proportion
     * to the span it holds.
     *
     * A px size is declared by the host, so this never changes one: a held slot
     * keeps its size whatever `want` says. Naming the widths settles a change
     * with the slots it touches and leaves the rest where they are.
     */
    setSlotWidths(axis, want) {
        const a = this.arr(axis);
        const count = a.length - 1;
        if (want.length !== count || this.size(axis) <= 0)
            return;
        const held = heldSizes(this.plane, axis);
        const sizes = slotSizes(this.plane, axis);
        // What the sharing slots divide between them, measured as the plane stands.
        // It does not depend on how they currently divide it.
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
                size[i] = Math.max(0, want[i] + corridorOf(this.plane, axis, i));
                named += size[i];
            }
        }
        const left = Math.max(0, room - named);
        for (let i = 0; i < count; i++) {
            if (held[i] !== null || want[i] !== null)
                continue;
            size[i] = open > EPS ? (left * (a[i + 1] - a[i])) / open : left / nulls;
        }
        // Re-proportion the sharing spans to those sizes, keeping the total span
        // they occupy so no other line moves. Read the spans from a copy: the loop
        // writes into `a` as it goes.
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
     * Settle a change with the sharing slot nearest the boundary.
     *
     * `order` lists the slots to try, nearest first. The first one that leaves
     * every card its minimum takes the room; when none does, every sharing slot
     * shares it. Each candidate is applied and measured, so there is one answer
     * to what a slot is worth, not a prediction beside it.
     *
     * Returns the slot that took the room, or -1.
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
     * Set one slot's px size and take the difference from the slot on the other
     * side of the boundary.
     *
     * A drag moves one boundary: the two slots meeting there change and no other
     * slot does.
     */
    resizeSlot(axis, slot, size, pays) {
        const width = slotWidths(this.plane, axis);
        const delta = size - width[slot];
        this.declare(axis, slot, size);
        const want = [...width];
        want[slot] = size;
        if (pays < 0 || pays >= want.length || pays === slot) {
            this.setSlotWidths(axis, want);
            return;
        }
        if (heldSizes(this.plane, axis)[pays] !== null) {
            // Two px slots meet here: the one after gives up what the one before took.
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
        return linePositions(this.plane, axis)[line];
    }
    /** The nearest line on this side that some card actually reads. */
    realNeighbour(axis, line, step) {
        const last = this.arr(axis).length - 1;
        let at = line + step;
        while (at > 0 && at < last && this.isVirtual(axis, at))
            at += step;
        return at;
    }
    /**
     * How far a boundary may travel before a card would fall under `minSize`.
     *
     * The range extends to the nearest line a card references. Lines no card
     * references do not constrain it.
     */
    /**
     * Whether `line` is an interior line index.
     *
     * Index 0 and the last index are the plane's borders and are not boundaries.
     */
    hasBoundary(axis, line) {
        return Number.isInteger(line) && line >= 1 && line <= this.arr(axis).length - 2;
    }
    boundaryRange(axis, line) {
        var _a, _b;
        const along = linePositions(this.plane, axis);
        const [lo, hi] = SPAN[axis];
        // The neighbouring lines are the hard limits: past one of them the line
        // array is out of order, and a card gets drawn wider than one that spans
        // more slots than it does.
        const first = (_a = along[this.realNeighbour(axis, line, -1)]) !== null && _a !== void 0 ? _a : 0;
        const last = (_b = along[this.realNeighbour(axis, line, 1)]) !== null && _b !== void 0 ? _b : this.size(axis);
        let min = first;
        let max = last;
        for (const card of this.list) {
            const near = inset(this.plane, axis, card[lo], 'lo');
            const far = inset(this.plane, axis, card[hi], 'hi');
            if (card[hi] === line)
                min = Math.max(min, along[card[lo]] + this.min + near + far);
            if (card[lo] === line)
                max = Math.min(max, along[card[hi]] - this.min - near - far);
        }
        // Two cards can ask for more room than the plane holds. Neither gets its
        // minimum then, so the range is one point between the neighbours rather
        // than an inverted pair every caller has to guard against.
        if (min > max) {
            const mid = clamp((min + max) / 2, first, last);
            return [mid, mid];
        }
        return [min, max];
    }
    /**
     * Move a boundary to a position in px.
     *
     * Next to a slot with a px size, this changes that size. Otherwise it moves
     * the line and every card referencing it follows.
     *
     * Returns the resulting position.
     */
    moveBoundary(axis, line, px, allowSnap = true) {
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
            // Measure from the edge that is not moving. Both positions are read
            // before the change.
            const [lo, hi] = SPAN[axis];
            const along = linePositions(this.plane, axis);
            const slot = holder[hi] === line
                ? target - along[holder[lo]] // its far edge moved; its start is fixed
                : along[holder[hi]] - target; // its near edge moved; its end is fixed
            // `slot` is line to line; subtract the corridor to get the drawn size.
            // A card holding a px size stands in one slot: `changed` drops the size
            // from a card that spans more.
            const size = Math.max(0, slot - corridorOf(this.plane, axis, holder[lo]));
            // The slot on the other side of the boundary pays for the change.
            this.resizeSlot(axis, holder[lo], size, holder[hi] === line ? line : line - 1);
        }
        else {
            const usable = this.sharedExtent(axis);
            const before = linePositions(this.plane, axis)[line - 1];
            const a = this.arr(axis);
            // Only the shared slots carry normalised width, so convert against those.
            a[line] = usable > EPS ? a[line - 1] + (target - before) / usable : a[line - 1];
        }
        this.changed();
        return this.boundaryPos(axis, line);
    }
    /**
     * Remove the unreferenced lines a move passes, and return the moved index.
     *
     * A line the move has passed would leave the array out of order.
     */
    forgetLinesPassed(axis, line, target) {
        const a = this.arr(axis);
        // No card reads these lines, so which neighbour absorbs makes no difference.
        const drop = (k) => this.removeLine(axis, k, 'lo');
        // `target` is px; the line array is normalised, so compare in px.
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
    /** How many px the sharing slots have between them, per unit of normalised span. */
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
     * Move a boundary so the two cards beside it are the same size.
     *
     * Not the midpoint of the two lines: a card at the plane's border insets on
     * one side only.
     */
    centerBoundary(axis, line) {
        var _a, _b;
        if (!this.hasBoundary(axis, line))
            return this.boundaryPos(axis, line);
        const along = linePositions(this.plane, axis);
        const [lo, hi] = SPAN[axis];
        let start = (_a = along[line - 1]) !== null && _a !== void 0 ? _a : 0;
        let end = (_b = along[line + 1]) !== null && _b !== void 0 ? _b : this.size(axis);
        let insStart = inset(this.plane, axis, line - 1, 'lo');
        let insEnd = inset(this.plane, axis, line + 1, 'hi');
        for (const card of this.list) {
            if (card[hi] === line && along[card[lo]] >= start) {
                start = along[card[lo]];
                insStart = inset(this.plane, axis, card[lo], 'lo');
            }
            if (card[lo] === line && along[card[hi]] <= end) {
                end = along[card[hi]];
                insEnd = inset(this.plane, axis, card[hi], 'hi');
            }
        }
        return this.moveBoundary(axis, line, (start + end) / 2 + (insStart - insEnd) / 2, false);
    }
    /**
     * Merge a line onto a neighbour at the same coordinate.
     *
     * Returns false when a card spans the pair, which would leave it with no size.
     */
    mergeCoincident(axis, line) {
        if (this.snap === 'off')
            return false;
        const a = this.arr(axis);
        const [lo, hi] = SPAN[axis];
        const other = [line - 1, line + 1].find((i) => i > 0 && i < a.length - 1 && Math.abs(a[i] - a[line]) < EPS);
        if (other === undefined)
            return false;
        const at = (card, k) => (card[k] === line ? other : card[k]);
        if (this.list.some((c) => at(c, lo) === at(c, hi)))
            return false;
        for (const card of this.list) {
            card[lo] = at(card, lo);
            card[hi] = at(card, hi);
        }
        // Every card now reads `other`, so which neighbour absorbs makes no
        // difference.
        this.removeLine(axis, line, 'lo');
        this.changed();
        return true;
    }
    /** Drop lines no card reads any more. Returns how many went. */
    tidy() {
        let dropped = 0;
        for (const axis of AXES) {
            for (let k = this.arr(axis).length - 2; k >= 1; k--) {
                if (!this.isVirtual(axis, k))
                    continue;
                // No card reads the line, so which neighbour absorbs makes no difference.
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
     * Where to cut.
     *
     * The unreferenced line nearest the card's centre that leaves both halves at
     * `minSize`; otherwise a new line at the centre, clamped to the range that
     * fits.
     */
    cutAt(card, axis) {
        if (card.fixed)
            return null;
        const a = this.arr(axis);
        const [lo, hi] = SPAN[axis];
        // px per unit of span: the card's own size, or what the sharing slots hold.
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
    /** The smallest side every card has, so a change can be asked what it cost. */
    extents(axis) {
        const out = new Map();
        for (const [id, r] of this.rects())
            out.set(id, axis === 'x' ? r.w : r.h);
        return out;
    }
    /** Whether every card is drawn with area. A card with none is not a card. */
    hasArea() {
        const frame = frameOf(this.plane);
        return this.list.every((c) => {
            const r = rectIn(frame, c);
            return r.w > 0 && r.h > 0;
        });
    }
    /**
     * Whether every card still has the room it had, or `minSize`, whichever is
     * less.
     *
     * A new line adds a corridor, which is taken from the shared slots, so a
     * split can push a card elsewhere below its size.
     */
    stillFits(axis, before) {
        // Every card must have area, including one just created.
        if (!this.hasArea())
            return false;
        for (const [id, now] of this.extents(axis)) {
            // `minSize` applies only to cards that were already present. A new card
            // is the size it was given; the halves of a cut are checked by `cutAt`.
            const was = before.get(id);
            if (was === undefined)
                continue;
            if (now < Math.min(this.min, was) - 0.01)
                return false;
        }
        return true;
    }
    /** True when the cut would leave every card the room it has, or `minSize`. */
    canSplit(id, axis) {
        // canSplit runs a trial split, which copies the state twice. The result is
        // cached until the next change: a host redraw calls this once per card per
        // axis, 134 times at 67 cards.
        const key = `${id}:${axis}`;
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
     * half. Cards spanning the new line widen their span instead of being cut.
     *
     * The new card gets no `data` unless `init.data` is given. A px size on the
     * other axis is copied, since both halves stay in that slot. A px size on the
     * cut axis is divided between them.
     *
     * Returns the new card's id, or null when there is no room.
     */
    split(id, axis, init = {}) {
        var _a;
        if (axis !== 'x' && axis !== 'y')
            return null;
        const card = this.find(id);
        const cut = card && this.cutAt(card, axis);
        if (!card || !cut)
            return null;
        const was = this.extents(axis);
        const undo = this.toJSON();
        const a = this.arr(axis);
        const [lo, hi] = SPAN[axis];
        // Read before the cut: the new line makes the card span two slots.
        const whole = fixedSize(card, axis);
        const from = a[card[lo]];
        const to = a[card[hi]];
        let line = cut.line;
        if (line < 0) {
            // The new line goes strictly inside the card's span.
            line = card[lo] + 1;
            while (line < card[hi] && a[line] <= cut.value + EPS)
                line++;
            // A line inside a card, not a slot at a boundary: every span at or past
            // this index moves with it, including a card that ends here.
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
        // A px size on the other axis is copied: both halves stay in that slot.
        const across = other(axis);
        const alongside = fixedSize(card, across);
        if (alongside !== null) {
            if (across === 'x')
                fresh.width = alongside;
            else
                fresh.height = alongside;
        }
        // A px size on the cut axis is divided in the proportion the line fell at.
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
        this.paidBy.set(fresh.id, 'lo');
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
     * `split` gives the far half to the new card, so `left` and `top` swap the
     * two spans. Ids are not swapped.
     */
    splitToward(id, side, init = {}) {
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
        this.paidBy.set(fresh.id, 'hi'); // the halves were swapped
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
     * Which neighbours would grow over a card if it closed, as frozen copies.
     *
     * `null` when no row of neighbours matches a side, which is when `close`
     * removes the card's slots instead.
     */
    fill(id) {
        const found = this.fillOf(id);
        return found && { ...found, cards: found.cards.map((c) => Object.freeze({ ...c })) };
    }
    /** The same, holding the cards themselves, so `close` can grow them. */
    fillOf(id) {
        const card = this.find(id);
        return card ? fillFor(this.list, card, this.order, this.sliceMemo) : null;
    }
    /**
     * The axis on which this card's slots hold no other card, or null.
     *
     * On that axis the slots can be removed when the card closes, without a
     * neighbour growing over it. Returns null when another card lies entirely
     * inside the range, which would leave it spanning nothing.
     */
    soleSlots(card) {
        for (const axis of AXES) {
            const [lo, hi] = SPAN[axis];
            // Removing the slots shrinks every card reaching into them. Refused when
            // another card lies entirely inside the range.
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
     * A row of neighbours grows over the space when one matches the side.
     * Otherwise the card's slots are removed. Returns false when neither
     * applies, or when the card is `fixed`, or when it is the last one.
     */
    close(id) {
        const card = this.removable(id);
        if (!card)
            return false;
        // Return the span to the side that gave it up, by removing the line on that
        // side. Only when no other card is in these slots.
        const paid = this.paidBy.get(id);
        if (paid) {
            for (const axis of AXES) {
                const [lo, hi] = SPAN[axis];
                if (card[hi] - card[lo] !== 1)
                    continue;
                const alone = this.list.every((c) => c === card || c[hi] <= card[lo] || c[lo] >= card[hi]);
                if (!alone)
                    continue;
                const gone = paid === 'lo' ? card[lo] : card[hi];
                if (gone <= 0 || gone >= this.arr(axis).length - 1)
                    continue;
                // Removing the line grows every card that ends or starts on it. Only
                // the one that gave the span up should grow, so take this path only
                // when it is the sole other card referencing the line.
                const reading = this.list.filter((c) => c !== card && (c[lo] === gone || c[hi] === gone));
                if (reading.length !== 1)
                    continue;
                const held = slotWidths(this.plane, axis);
                this.list.splice(this.list.indexOf(card), 1);
                this.removeLine(axis, gone, paid);
                this.paidBy.delete(id);
                // The card's slot merges with the one that gave it up, and that slot
                // takes the room back. No other slot changes width.
                const want = held.filter((_, i) => i !== gone);
                this.settleOn(axis, want, order(gone - 1, want.length));
                this.changed();
                return true;
            }
        }
        const filling = this.fillOf(id);
        if (filling) {
            const axis = filling.grow === 'c0' || filling.grow === 'c1' ? 'x' : 'y';
            const [lo, hi] = SPAN[axis];
            const from = card[lo];
            const to = card[hi];
            const want = slotWidths(this.plane, axis);
            for (const neighbour of filling.cards)
                neighbour[filling.grow] = card[filling.grow];
            this.list.splice(this.list.indexOf(card), 1);
            // The slots the card stood in go to the neighbour that grew over them.
            // Every other slot keeps the width it had.
            this.settleOn(axis, want, order(from, want.length, to - 1));
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
        // The slots are gone; the neighbour that absorbed them takes the room.
        const kept = held.filter((_, i) => i < from || i >= from + count);
        this.settleOn(axis, kept, order(Math.min(from, kept.length - 1), kept.length));
        this.changed();
        return true;
    }
    /**
     * Whether a card reaching across the plane can stand on this boundary.
     *
     * True when no card spans over the line. `without` ignores one card by id.
     */
    canInsertAt(axis, line, without) {
        const a = this.arr(axis);
        if (!Number.isInteger(line) || line < 0 || line > a.length - 1)
            return false;
        return this.cardsCrossing(axis, line).every((c) => c.id === without);
    }
    /**
     * Put a card at a boundary, reaching across the whole plane.
     *
     * Unlike `splitToward`, the new card spans the whole plane on the other axis.
     * Cards past the boundary shift by one index.
     *
     * `size` is required, in px, and must be less than the plane. It becomes a
     * span taken from the whole plane in proportion.
     *
     * Returns the new card's id, or null when a card spans the boundary, the size
     * is invalid, or the result would leave a card without area.
     */
    insertAt(axis, line, init) {
        var _a;
        const plane = this.size(axis);
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
        // The slot next to the new one pays for it, so a close at the same
        // boundary hands the room straight back. Every other slot keeps its width.
        const want = new Array(this.arr(axis).length - 1).fill(0);
        for (let i = 0; i < held.length; i++)
            want[i >= line ? i + 1 : i] = held[i];
        want[line] = init.size;
        const pays = this.settleOn(axis, want, order(line + 1, want.length, line - 1));
        if (pays >= 0)
            this.paidBy.set(fresh.id, pays > line ? 'hi' : 'lo');
        this.changed();
        if (!this.stillFits(axis, was)) {
            this.restore(undo);
            return null;
        }
        return fresh.id;
    }
    /** Whether a card occupies one slot and reaches across everything else. */
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
     * keeps its index; a card starting there shifts by one.
     */
    openSlot(axis, line, span) {
        const a = this.arr(axis);
        // The new slot takes its span from the slot next to the boundary, so a
        // close that merges it back into that slot restores the previous spans.
        // Which slot depends on where there is room.
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
            // Neither neighbour has the room on its own; take it from the whole plane.
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
     * Remove a slot and scale the rest so they still sum to the plane.
     *
     * Removes the far line, or the near line for the last slot, so the plane's
     * two borders are never removed.
     */
    /**
     * Remove one line and shift the spans that referenced it.
     *
     * `into` says which neighbouring slot absorbs the one that goes, which
     * decides whether a card ending on the line follows it or reaches past it.
     */
    /**
     * Open a slot at a boundary and shift the spans that referenced it.
     *
     * A card that starts on the line moves past the new slot; one that ends on it
     * stays where it ends. This is what `removeLine(axis, line, 'hi')` undoes.
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
    dropSlot(axis, slot) {
        const a = this.arr(axis);
        if (a.length <= 2)
            return; // one slot, no interior line, nothing to take
        // Remove the interior line: the far one, or the near one for the last slot,
        // so the plane's two borders are never removed. The neighbour that absorbs
        // the slot is the one on the other side of the line that goes.
        const last = slot + 1 >= a.length - 1;
        this.removeLine(axis, last ? slot : slot + 1, last ? 'lo' : 'hi');
    }
    /**
     * Move a plane-spanning card to another boundary.
     *
     * Its slot is removed and a slot of the same span is inserted at the target.
     * No other card's spans change and no line on the other axis moves.
     *
     * `line` is an index in the current arrangement.
     */
    moveTo(id, axis, line) {
        const card = this.find(id);
        // `fixed` blocks the layout, not a direct call. This changes no other
        // card's spans and no line on the other axis, so it is allowed.
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
        // The slot travels; it is not given to a neighbour and taken back from
        // another. Move the indices first, since canInsertAt reads only those.
        // The card is out of the list, so the slot after it absorbs the line.
        this.removeLine(axis, from + 1, 'hi');
        // The target boundary shifted down by one if it stood past the slot that left.
        const target = line > from + 1 ? line - 1 : line;
        if (!this.canInsertAt(axis, target)) {
            this.restore(before);
            return false;
        }
        a.splice(target, 0, 0);
        this.openIndex(axis, target);
        // Write every coordinate from the one it had. The cards the slot passes
        // shift by its span once; the rest keep their exact value. Shifting the
        // whole tail out and back added a rounding error to every line.
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
        // The slot leaves one boundary and arrives at another, so the neighbours
        // that give and take are not the same pair. Refuse when that leaves a card
        // without area.
        if (!this.hasArea()) {
            this.restore(before);
            return false;
        }
        return true;
    }
    /**
     * Every boundary a plane-spanning card could stand on.
     *
     * `without` ignores one card by id, so a card already standing somewhere can
     * ask where else it could stand without blocking itself.
     */
    standings(axis, without) {
        // Includes the plane's two borders, which `insertAt` accepts.
        const out = [];
        for (let k = 0; k < this.arr(axis).length; k++) {
            if (this.canInsertAt(axis, k, without))
                out.push(k);
        }
        return out;
    }
    /**
     * Move a card to sit on one side of another — the drag-and-drop operation.
     *
     * One operation rather than a close and a split the caller sequences, because
     * the order matters: closing first gives the space back and changes the
     * target's geometry, so the cut is measured after that, and a close that
     * cannot happen leaves the whole move undone rather than half of it.
     *
     * The card keeps its id, its payload and its fixed size, so a live surface
     * rides along and a sidebar stays the width it was.
     */
    move(id, targetId, side) {
        if (!SIDES.includes(side))
            return false;
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
        // The size a card holds is its own; the axis it now stands on decides which.
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
        const probe = new Soksak(this.toJSON(), {
            gap: this.gap,
            minSize: this.min,
            grabSize: this.grabSize,
            snapDistance: this.snapDistance,
            snap: this.snap,
            fillOrder: this.order,
            width: this.w,
            height: this.h,
        });
        return probe.move(id, targetId, side);
    }
    /** Put the arrangement back to a state it reported earlier. */
    /**
     * What every operation does when it is finished.
     *
     * A px size describes one slot. A card that comes to reach across two is not
     * that size any more and cannot be — so the number goes, rather than lying
     * dormant on the card and coming back to life at some later, unrelated split.
     */
    changed() {
        // A trial split discards its state, so it must not clear the cache.
        if (!this.probing)
            this.splitMemo.clear();
        this.agreeSizes();
        this.sliceMemo.clear();
    }
    /**
     * Make every card in a slot declare the same px size, the largest asked for,
     * and drop a size from a card that no longer stands in one slot.
     *
     * A slot has one width, so two cards in it cannot ask for different ones.
     * `heldSizes` reads the largest, and this writes that back, so what `toJSON`
     * reports is what gets drawn. Run it wherever cards arrive or move.
     */
    agreeSizes() {
        // A card that is gone leaves nothing to pay back, and a trial operation
        // that was rolled back leaves an entry for an id that never existed.
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
    restore(state) {
        this.xs = [...state.xs];
        this.ys = [...state.ys];
        this.list = state.cards.map((c) => { var _a; return ({ ...c, fixed: (_a = c.fixed) !== null && _a !== void 0 ? _a : false }); });
        this.agreeSizes();
        this.sliceMemo.clear();
        if (!this.probing)
            this.splitMemo.clear();
    }
}
