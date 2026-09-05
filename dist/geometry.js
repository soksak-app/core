/**
 * Coordinate computation.
 *
 * `xs` and `ys` hold every position, normalised 0..1 over the slots that share
 * the remaining space. A slot with a px size is drawn at that size whatever its
 * span, so a line's px position is not its value times the plane size. A card is
 * a span of indices into them, so two cards that meet reference the same index.
 *
 * Every function here is pure and takes the plane as an argument.
 */
import { AXES, SPAN, fixedSize, other } from './card.js';
const lines = (plane, axis) => (axis === 'x' ? plane.xs : plane.ys);
const extent = (plane, axis) => (axis === 'x' ? plane.width : plane.height);
/**
 * The gap a slot holds: half a gap for every card edge that insets into it.
 *
 * Lines at one position form one boundary, and a zero-width slot cannot hold a
 * gap, so the cost falls on the nearest slot that can. Two lines of a run can
 * each place an edge here, and one half gap covers both, so the run takes the
 * largest value rather than the sum.
 */
export function corridorOf(plane, axis, slot, read = linesRead(plane, axis)) {
    const a = lines(plane, axis);
    if (blank(plane, axis, slot))
        return 0;
    let lo = inset(plane, axis, slot, 'lo', read);
    for (let k = slot - 1; k >= 0 && blank(plane, axis, k); k--) {
        lo = Math.max(lo, inset(plane, axis, k, 'lo', read));
    }
    let hi = inset(plane, axis, slot + 1, 'hi', read);
    for (let k = slot + 2; k < a.length && blank(plane, axis, k - 1); k++) {
        hi = Math.max(hi, inset(plane, axis, k, 'hi', read));
    }
    return lo + hi;
}
/**
 * True when a slot draws at zero width: no span to take a share with and no px
 * size. The two lines around it land at the same position.
 *
 * The cards are scanned only when a slot has no span, which is rare, so a plane
 * with no coincident lines costs one subtraction per call.
 */
function blank(plane, axis, slot) {
    const a = lines(plane, axis);
    if (a[slot + 1] - a[slot] >= 1e-9)
        return false;
    const [lo] = SPAN[axis];
    for (const card of plane.cards) {
        if (card[lo] === slot && fixedSize(card, axis) !== null)
            return false;
    }
    return true;
}
/** The px size each slot declares: the largest value any card in it sets. */
export function heldSizes(plane, axis) {
    var _a;
    const [lo] = SPAN[axis];
    const held = new Array(lines(plane, axis).length - 1).fill(null);
    for (const card of plane.cards) {
        const size = fixedSize(card, axis);
        if (size === null)
            continue;
        held[card[lo]] = Math.max((_a = held[card[lo]]) !== null && _a !== void 0 ? _a : 0, size);
    }
    return held;
}
/** Drawn width of every slot, gap removed. */
export function slotWidths(plane, axis) {
    const read = linesRead(plane, axis);
    return slotSizes(plane, axis).map((size, i) => size - corridorOf(plane, axis, i, read));
}
/**
 * Width in px of every slot on an axis.
 *
 * A slot with a px size takes that size; the rest divide the remainder in
 * proportion to their spans, down to `minSize` each.
 *
 * When the px sizes do not fit, they are scaled by one factor so the slots still
 * sum to the plane size.
 */
export function slotSizes(plane, axis) {
    const a = lines(plane, axis);
    const count = a.length - 1;
    // The slot holds the gap, so a px size is the drawn width.
    const read = linesRead(plane, axis); // one pass, not one per slot
    const corridor = new Array(count);
    for (let i = 0; i < count; i++)
        corridor[i] = corridorOf(plane, axis, i, read);
    // What each slot requires: the px size its cards declare, or none, in which
    // case it shares the remainder.
    const held = heldSizes(plane, axis);
    let asked = 0; // px the held slots were told to be
    let taken = 0; // corridor those slots carry on top
    let sharedSpan = 0; // how the rest divide what is left
    let floor = 0; // corridor the sharing slots carry
    for (let i = 0; i < count; i++) {
        if (held[i] !== null) {
            asked += held[i];
            taken += corridor[i];
        }
        else {
            sharedSpan += a[i + 1] - a[i];
            floor += corridor[i];
        }
    }
    // Plus one card's minimum between them. Counting per slot would overcount a
    // card that spans several.
    if (sharedSpan > 1e-9)
        floor += plane.minSize;
    const usable = extent(plane, axis) - asked - taken;
    if (sharedSpan > 1e-9 && usable >= floor) {
        const size = held.map((fixed, i) => (fixed !== null ? fixed + corridor[i] : 0));
        // Divide `usable` by span, but no sharing slot goes below the gap it holds.
        // A narrower slot draws its card at zero width and places its neighbours
        // closer than one gap. Such a slot stops at its gap and the rest divide the
        // remainder, so only a plane too small for its contents is affected.
        const stopped = new Array(count).fill(false);
        let room = usable;
        let pool = sharedSpan;
        for (;;) {
            const each = pool > 1e-9 ? room / pool : 0;
            let starved = -1;
            for (let i = 0; i < count; i++) {
                if (held[i] !== null || stopped[i])
                    continue;
                if ((a[i + 1] - a[i]) * each < corridor[i] - 1e-9) {
                    starved = i;
                    break;
                }
            }
            if (starved < 0) {
                for (let i = 0; i < count; i++) {
                    if (held[i] !== null || stopped[i])
                        continue;
                    size[i] = (a[i + 1] - a[i]) * each;
                }
                return size;
            }
            // `usable` is at least the gaps plus one card minimum, so stopping every
            // slot at its gap still leaves size and span to divide.
            stopped[starved] = true;
            size[starved] = corridor[starved];
            room -= corridor[starved];
            pool -= a[starved + 1] - a[starved];
        }
    }
    // The requested sizes do not fit, or no slot shares. The sharing slots keep
    // their floor and the px sizes scale by one factor, preserving their
    // proportions. A sidebar then narrows with the window instead of pushing the
    // panes below `minSize` or extending past the plane, and a closing card always
    // has a slot to give its space to.
    const keep = Math.min(floor, Math.max(0, extent(plane, axis) - taken));
    const left = Math.max(0, extent(plane, axis) - keep - taken);
    const scale = asked > 1e-9 ? left / asked : 0;
    // A sharing slot takes its gap first, then a share of the remainder.
    let floors = 0;
    for (let i = 0; i < count; i++)
        if (held[i] === null)
            floors += corridor[i];
    const spare = Math.max(0, keep - floors);
    const each = sharedSpan > 1e-9 ? spare / sharedSpan : 0;
    return held.map((fixed, i) => fixed !== null ? fixed * scale + corridor[i] : corridor[i] + (a[i + 1] - a[i]) * each);
}
/** Every line position in px, index for index with the line array. */
export function linePositions(plane, axis) {
    const sizes = slotSizes(plane, axis);
    const out = [0];
    for (const size of sizes)
        out.push(out[out.length - 1] + size);
    return out;
}
/** How far a card's edge insets from its line: half a gap, or 0 at a border. */
/**
 * Gap width for this axis, capped at what the plane can hold.
 *
 * Each interior line that a card references costs one gap. When the total
 * exceeds the plane size, the gap is reduced to fit. Every slot is at least the
 * gap it holds; a card whose own lines are at one position has zero width, and
 * `rectIn` places it accordingly.
 */
function corridor(plane, axis, read = linesRead(plane, axis)) {
    const a = lines(plane, axis);
    // Counted from the set rather than scanned: every card span is an index into
    // the lines, so the interior ones are the set minus whichever borders it
    // contains. `inset` calls this once per line.
    let real = read.size;
    if (read.has(0))
        real--;
    if (read.has(a.length - 1))
        real--;
    if (real <= 0)
        return plane.gap;
    return Math.min(plane.gap, Math.max(0, extent(plane, axis)) / real);
}
/** Line indices that at least one card references. */
function linesRead(plane, axis) {
    const [lo, hi] = SPAN[axis];
    const read = new Set();
    for (const card of plane.cards) {
        read.add(card[lo]);
        read.add(card[hi]);
    }
    return read;
}
/**
 * How far a card's edge insets from the line it references.
 *
 * `read` is the set of lines any card references. Computing it costs one pass
 * over the cards, so a caller that needs many lines computes it once and passes
 * it in. Without that, a loop over N cards scans the cards N times.
 */
export function inset(plane, axis, index, side, read = linesRead(plane, axis)) {
    const a = lines(plane, axis);
    const flush = side === 'lo' ? index === 0 : index === a.length - 1;
    if (flush)
        return 0;
    // A line no card references separates nothing and takes no gap.
    if (!read.has(index))
        return 0;
    // Lines at one position form one boundary. The card on this side has its size
    // in the first slot past the zero-width ones, so the run is scanned rather
    // than treated as one slot: a card spanning coincident lines still insets half
    // a gap from what it meets. A run ending at the plane's edge has nothing to
    // inset into and the card there is drawn against the border.
    const step = side === 'lo' ? 1 : -1;
    let slot = side === 'lo' ? index : index - 1;
    while (slot >= 0 && slot <= a.length - 2 && blank(plane, axis, slot))
        slot += step;
    if (slot < 0 || slot > a.length - 2)
        return 0;
    return corridor(plane, axis, read) / 2;
}
/** Half the gap a referenced line takes, capped at what the plane can hold. */
export function halfCorridor(plane, axis, read = linesRead(plane, axis)) {
    return corridor(plane, axis, read) / 2;
}
/** The lines any card references. One pass over the cards. */
export function linesReadOn(plane, axis) {
    return linesRead(plane, axis);
}
/**
 * Line positions and edge insets for both axes.
 *
 * Computed once and passed to `rectIn`, so placing N cards is O(N) rather than
 * O(N squared).
 */
export function frameOf(plane) {
    const axle = (axis) => {
        const a = lines(plane, axis);
        const read = linesRead(plane, axis); // one pass, not one per line
        const sizes = slotSizes(plane, axis);
        const at = [0];
        for (const size of sizes)
            at.push(at[at.length - 1] + size);
        // Delegated to `inset` rather than recomputed. A second copy of the rule
        // produced a different result over coincident lines.
        const lo = a.map((_, i) => inset(plane, axis, i, 'lo', read));
        const hi = a.map((_, i) => inset(plane, axis, i, 'hi', read));
        return { at, lo, hi };
    };
    return { x: axle('x'), y: axle('y') };
}
/** Rect of one card from a precomputed frame. */
export function rectIn(frame, card) {
    const [x, w] = span(frame.x, card.c0, card.c1);
    const [y, h] = span(frame.y, card.r0, card.r1);
    return { x, y, w, h };
}
/**
 * One axis of a rect: the card's start position and size.
 *
 * A card whose two lines are at one position has its far edge before its near
 * one. It has no size there, so it is drawn at zero width in the middle of the
 * slots it spans rather than inverted. That position is where its lines are,
 * inside the single gap separating the cards on either side of the run.
 */
function span(axle, lo, hi) {
    const near = axle.at[lo] + axle.lo[lo];
    const far = axle.at[hi] - axle.hi[hi];
    // A card clamped to exactly zero width lands a rounding on either side of its
    // near edge. Treating that as inverted would move it to the middle of its
    // slots and make the gap before it slightly under one gap.
    if (far >= near - 1e-6)
        return [near, Math.max(0, far - near)];
    return [(axle.at[lo] + axle.at[hi]) / 2, 0];
}
/** The rect of one card. Every rect in the library is computed here. */
export function rectOf(plane, card) {
    return rectIn(frameOf(plane), card);
}
/** Cards that span across a line. Their presence blocks placement on it. */
export function crossing(plane, axis, line) {
    const [lo, hi] = SPAN[axis];
    return plane.cards.filter((c) => c[lo] < line && c[hi] > line);
}
export function touching(plane, axis) {
    const [lo, hi] = SPAN[axis];
    const ends = new Map();
    const starts = new Map();
    const push = (m, k, c) => {
        const at = m.get(k);
        if (at)
            at.push(c);
        else
            m.set(k, [c]);
    };
    for (const card of plane.cards) {
        push(ends, card[hi], card);
        push(starts, card[lo], card);
    }
    return { ends, starts };
}
/**
 * Index stretches where cards actually break on a line.
 *
 * A line runs the whole plane but is a boundary only where one card ends and
 * another begins. Elsewhere a card spans across it, so there is nothing to drag
 * and nothing to draw solid.
 */
export function boundarySpans(plane, axis, line, meet = touching(plane, axis)) {
    const [o0, o1] = SPAN[other(axis)];
    // The spans the cards ending here cover, intersected with the spans the cards
    // starting here cover. Comparing each pair directly gives the same result but
    // costs one comparison per card pair.
    const before = cover(meet.ends.get(line), o0, o1);
    const after = cover(meet.starts.get(line), o0, o1);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        const start = Math.max(before[i][0], after[j][0]);
        const end = Math.min(before[i][1], after[j][1]);
        if (end > start)
            out.push([start, end]);
        if (before[i][1] < after[j][1])
            i++;
        else
            j++;
    }
    return out;
}
/** The spans a set of cards covers on the other axis, sorted and merged. */
function cover(cards, o0, o1) {
    if (!(cards === null || cards === void 0 ? void 0 : cards.length))
        return [];
    const spans = cards.map((c) => [c[o0], c[o1]]).sort((a, b) => a[0] - b[0]);
    const out = [spans[0]];
    for (const span of spans) {
        const last = out[out.length - 1];
        if (span[0] <= last[1])
            last[1] = Math.max(last[1], span[1]);
        else
            out.push([span[0], span[1]]);
    }
    return out;
}
/** True when no card references this line. */
export function isVirtual(plane, axis, line, read = linesRead(plane, axis)) {
    return !read.has(line);
}
/** Interior line indices. The two borders are excluded. */
export function interiorLines(plane, axis) {
    const a = lines(plane, axis);
    const out = [];
    for (let k = 1; k < a.length - 1; k++)
        out.push(k);
    return out;
}
/**
 * The rules to draw for every boundary.
 *
 * A line runs the whole plane, so it produces one rule of that length. It is a
 * boundary only where cards break on it, so each of those stretches produces a
 * solid rule. Draw the first faintly and the second at full strength.
 */
export function rules(plane) {
    const out = [];
    const frame = frameOf(plane);
    for (const axis of AXES) {
        // The drawn gap, not the declared one. A plane too narrow for the declared
        // gap draws a smaller one, and a rule at the declared size extends past the
        // plane.
        const half = halfCorridor(plane, axis);
        const along = frame[axis].at;
        const across = axis === 'x' ? plane.height : plane.width;
        const down = other(axis);
        const meet = touching(plane, axis);
        // A rule stays inside the plane. Extending it half a gap past each end made
        // the host scroll, because the view places these in the host's element.
        const hold = (v) => Math.min(Math.max(v, 0), across);
        for (const line of interiorLines(plane, axis)) {
            const at = along[line] - 0.5;
            out.push(axis === 'x'
                ? { key: `vx:${line}`, axis, line, virtual: true, x: at, y: 0, w: 1, h: across }
                : { key: `vy:${line}`, axis, line, virtual: true, x: 0, y: at, w: across, h: 1 });
            for (const [from, to] of boundarySpans(plane, axis, line, meet)) {
                const start = hold(frame[down].at[from] + frame[down].lo[from] - half);
                const end = hold(frame[down].at[to] - frame[down].hi[to] + half);
                out.push(axis === 'x'
                    ? { key: `sx:${line}:${from}`, axis, line, virtual: false, x: at, y: start, w: 1, h: end - start }
                    : { key: `sy:${line}:${from}`, axis, line, virtual: false, x: start, y: at, w: end - start, h: 1 });
            }
        }
    }
    return out;
}
/**
 * The draggable area of a boundary.
 *
 * Only where cards break on the line. Elsewhere a card spans across it and there
 * is nothing to drag. The hit area is independent of the gap so a zero gap is
 * still draggable.
 */
export function dividers(plane, grabSize) {
    const out = [];
    const hit = Math.max(plane.gap, grabSize);
    const frame = frameOf(plane);
    for (const axis of AXES) {
        const along = frame[axis].at;
        const down = other(axis);
        const meet = touching(plane, axis);
        for (const line of interiorLines(plane, axis)) {
            for (const [from, to] of boundarySpans(plane, axis, line, meet)) {
                const start = frame[down].at[from] + frame[down].lo[from];
                const end = frame[down].at[to] - frame[down].hi[to];
                out.push(axis === 'x'
                    ? { key: `x:${line}:${from}`, axis, line, x: along[line] - hit / 2, y: start, w: hit, h: end - start }
                    : { key: `y:${line}:${from}`, axis, line, x: start, y: along[line] - hit / 2, w: end - start, h: hit });
            }
        }
    }
    return out;
}
export function zoneAt(plane, x, y, options = {}) {
    var _a, _b, _c;
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return null;
    const frame = frameOf(plane);
    const header = (_a = options.headerPx) !== null && _a !== void 0 ? _a : 0;
    const footer = (_b = options.footerPx) !== null && _b !== void 0 ? _b : 0;
    const edge = (_c = options.edge) !== null && _c !== void 0 ? _c : 0.25;
    for (const card of plane.cards) {
        const r = rectIn(frame, card);
        if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h)
            continue;
        if (card.id === options.centreOnly)
            return { id: card.id, zone: 'centre' };
        const top = r.y + header;
        const bottom = r.y + r.h - footer;
        if (bottom <= top || y < top || y > bottom)
            return { id: card.id, zone: 'centre' };
        // A card drawn at zero width or height has no drop zones. Dividing by it
        // gives NaN and every comparison below then falls to the last branch.
        if (!(r.w > 0) || !(bottom > top))
            return { id: card.id, zone: 'centre' };
        const px = (x - r.x) / r.w;
        const py = (y - top) / (bottom - top);
        if (px > edge && px < 1 - edge && py > edge && py < 1 - edge)
            return { id: card.id, zone: 'centre' };
        const nearest = Math.min(px, 1 - px, py, 1 - py);
        const zone = nearest === px ? 'left' : nearest === 1 - px ? 'right' : nearest === py ? 'top' : 'bottom';
        return { id: card.id, zone };
    }
    return null;
}
