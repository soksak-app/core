/**
 * The only place coordinates are computed.
 *
 * Two arrays of numbers own every position. A card is a span of indices into
 * them, so two cards that meet read the same index and their shared boundary is
 * one number — it cannot drift, and there is no tolerance anywhere that decides
 * whether two places are the same place.
 *
 * Every function here is pure. The arrangement holds the state and asks.
 */
import { AXES, CROSS, SPAN, fixedSize } from './card.js';
const lines = (plane, axis) => (axis === 'x' ? plane.xs : plane.ys);
const extent = (plane, axis) => (axis === 'x' ? plane.width : plane.height);
/**
 * The px width of every slot along an axis.
 *
 * The plane is covered exactly, always. A slot a card holds at a px size takes
 * that size and the rest share what is left — the whole story while there is
 * something left to share.
 *
 * When there is not — every slot held, or the plane narrower than what was
 * asked for — the px sizes scale together to cover it. A card that closes has
 * to send its room somewhere, and a sidebar narrowing with the window is the
 * same fact from the other side: a px size is what a card gets when the plane
 * can give it, not a claim on room the plane does not have.
 */
export function slotSizes(plane, axis) {
    var _a;
    const a = lines(plane, axis);
    const [lo] = SPAN[axis];
    const count = a.length - 1;
    // A px size is what the card is drawn at, so the slot carries the corridor
    // and the card never pays for it — otherwise the same 180 would draw 174 at
    // the plane's edge and 168 between two cards.
    const corridor = new Array(count);
    for (let i = 0; i < count; i++) {
        corridor[i] = inset(plane, axis, i, 'lo') + inset(plane, axis, i + 1, 'hi');
    }
    const held = new Array(count).fill(null);
    for (const card of plane.cards) {
        const size = fixedSize(card, axis);
        if (size === null)
            continue;
        const slot = card[lo];
        held[slot] = Math.max((_a = held[slot]) !== null && _a !== void 0 ? _a : 0, size);
    }
    let asked = 0; // px the held slots were told to be
    let taken = 0; // corridor those slots carry on top
    let sharedSpan = 0; // how the rest divide what is left
    let floor = 0; // the corridor the rest carry, whatever else they get
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
    // and between them one card's worth of room, so panes are not starved to
    // nothing while a sidebar keeps its number. Per slot would count a card that
    // spans several of them once for each.
    if (sharedSpan > 1e-9)
        floor += plane.minSize;
    const usable = extent(plane, axis) - asked - taken;
    if (sharedSpan > 1e-9 && usable >= floor) {
        const scale = usable / sharedSpan;
        return held.map((fixed, i) => fixed !== null ? fixed + corridor[i] : (a[i + 1] - a[i]) * scale);
    }
    // What was asked for does not fit, or nothing shares at all. The sharing
    // slots keep their floor and the px sizes scale together to cover the rest —
    // one multiple for all of them, so their proportions survive. A sidebar
    // narrows with the window rather than starving the panes or hanging off the
    // edge, and a card that closes always has somewhere to send its room.
    const keep = Math.min(floor, Math.max(0, extent(plane, axis) - taken));
    const left = Math.max(0, extent(plane, axis) - keep - taken);
    const scale = asked > 1e-9 ? left / asked : 0;
    // A sharing slot gets its corridor first and a share of what is over. Handing
    // out `keep` by span alone gave a slot less than the corridor it carries, and
    // the card in it a negative width — a 40px plane drew one at -10.
    let floors = 0;
    for (let i = 0; i < count; i++)
        if (held[i] === null)
            floors += corridor[i];
    const spare = Math.max(0, keep - floors);
    const each = sharedSpan > 1e-9 ? spare / sharedSpan : 0;
    return held.map((fixed, i) => fixed !== null ? fixed * scale + corridor[i] : corridor[i] + (a[i + 1] - a[i]) * each);
}
/** Where a grid line falls in px — the sum of every slot before it. */
export function linePos(plane, axis, index) {
    const sizes = slotSizes(plane, axis);
    let at = 0;
    for (let i = 0; i < index; i++)
        at += sizes[i];
    return at;
}
/** Every line position in px, index for index with the line array. */
export function linePositions(plane, axis) {
    const sizes = slotSizes(plane, axis);
    const out = [0];
    for (const size of sizes)
        out.push(out[out.length - 1] + size);
    return out;
}
/**
 * How far a card's edge pulls back from the line it sits on.
 *
 * Half a corridor on every side that faces another card, and nothing at the
 * plane's own border. One rule, so no card needs a special case.
 */
/**
 * The corridor the plane can actually afford on this axis.
 *
 * Every real interior line costs a whole gap. A plane narrower than what those
 * come to cannot pay for them, and taking the gap anyway gave every card a
 * negative width — a 10px plane drew two cards at -7. The plane cannot spend
 * what it does not have, so the corridor gives way before the cards do.
 */
function corridor(plane, axis, read = linesRead(plane, axis)) {
    const a = lines(plane, axis);
    let real = 0;
    for (let k = 1; k < a.length - 1; k++)
        if (read.has(k))
            real++;
    if (real === 0)
        return plane.gap;
    return Math.min(plane.gap, Math.max(0, extent(plane, axis)) / real);
}
/** Which line indices some card reads, in one pass over the cards. */
function linesRead(plane, axis) {
    const [lo, hi] = SPAN[axis];
    const read = new Set();
    for (const card of plane.cards) {
        read.add(card[lo]);
        read.add(card[hi]);
    }
    return read;
}
export function inset(plane, axis, index, side) {
    const a = lines(plane, axis);
    const flush = side === 'lo' ? index === 0 : index === a.length - 1;
    if (flush)
        return 0;
    // A corridor separates two cards. A line no card reads separates nothing, so
    // it costs nothing — it is a remembered position, and a memory that took a
    // gap's width from the plane every time one was kept would eventually eat the
    // cards: forty rail toggles left forty such lines and a 190px sidebar drawn
    // at 131.
    return isVirtual(plane, axis, index) ? 0 : corridor(plane, axis) / 2;
}
/** Where a card's edge falls in px. */
export function edgePos(plane, axis, index, side) {
    const at = linePos(plane, axis, index);
    const back = inset(plane, axis, index, side);
    return side === 'lo' ? at + back : at - back;
}
/**
 * Measure the plane once.
 *
 * `rectOf` asks for four edges, each of which asks where a line is, which walks
 * every slot, which walks every card. One rect was O(cards); a rect for every
 * card was O(cards squared) — 1,000 cards took 89ms to place. The answer is the
 * same for every card, so it is worked out once and handed round.
 */
export function frameOf(plane) {
    const axle = (axis) => {
        const a = lines(plane, axis);
        const read = linesRead(plane, axis); // one pass, not one per line
        const sizes = slotSizes(plane, axis);
        const at = [0];
        for (const size of sizes)
            at.push(at[at.length - 1] + size);
        const gap = corridor(plane, axis, read) / 2;
        const half = a.map((_, i) => (i === 0 || i === a.length - 1 || !read.has(i) ? 0 : gap));
        return { at, half };
    };
    return { x: axle('x'), y: axle('y') };
}
/** The rect of one card, from a plane already measured. */
export function rectIn(frame, card) {
    const x0 = frame.x.at[card.c0] + frame.x.half[card.c0];
    const x1 = frame.x.at[card.c1] - frame.x.half[card.c1];
    const y0 = frame.y.at[card.r0] + frame.y.half[card.r0];
    const y1 = frame.y.at[card.r1] - frame.y.half[card.r1];
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** The rect of one card. Every rect in the library comes from here. */
export function rectOf(plane, card) {
    return rectIn(frameOf(plane), card);
}
/** Cards that span across a line. They are why a card cannot be placed on it. */
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
export function boundarySpans(plane, axis, line, meet = touching(plane, axis)) {
    var _a, _b;
    const [o0, o1] = CROSS[axis];
    const spans = [];
    for (const before of (_a = meet.ends.get(line)) !== null && _a !== void 0 ? _a : []) {
        for (const after of (_b = meet.starts.get(line)) !== null && _b !== void 0 ? _b : []) {
            const start = Math.max(before[o0], after[o0]);
            const end = Math.min(before[o1], after[o1]);
            if (end > start)
                spans.push([start, end]);
        }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span[0] <= last[1])
            last[1] = Math.max(last[1], span[1]);
        else
            merged.push([span[0], span[1]]);
    }
    return merged;
}
/** Whether any card reads this line at all. One that none reads is only a memory of a boundary. */
export function isVirtual(plane, axis, line) {
    const [lo, hi] = SPAN[axis];
    return !plane.cards.some((c) => c[lo] === line || c[hi] === line);
}
/** The interior lines of an axis — the plane's own two borders are not boundaries. */
export function interiorLines(plane, axis) {
    const a = lines(plane, axis);
    const out = [];
    for (let k = 1; k < a.length - 1; k++)
        out.push(k);
    return out;
}
/**
 * Everything to draw for the boundaries.
 *
 * A line runs the whole plane, so it gets one rule that does; it is only a
 * boundary where cards actually break on it, so each of those stretches gets a
 * solid one. Draw the first faintly and the second not.
 */
export function rules(plane) {
    const out = [];
    const half = plane.gap / 2;
    const frame = frameOf(plane);
    for (const axis of AXES) {
        const along = frame[axis].at;
        const across = axis === 'x' ? plane.height : plane.width;
        const other = axis === 'x' ? 'y' : 'x';
        const meet = touching(plane, axis);
        for (const line of interiorLines(plane, axis)) {
            const at = along[line] - 0.5;
            out.push(axis === 'x'
                ? { key: `vx:${line}`, axis, line, virtual: true, x: at, y: -half, w: 1, h: across + plane.gap }
                : { key: `vy:${line}`, axis, line, virtual: true, x: -half, y: at, w: across + plane.gap, h: 1 });
            for (const [from, to] of boundarySpans(plane, axis, line, meet)) {
                const start = frame[other].at[from] + frame[other].half[from] - half;
                const end = frame[other].at[to] - frame[other].half[to] + half;
                out.push(axis === 'x'
                    ? { key: `sx:${line}:${from}`, axis, line, virtual: false, x: at, y: start, w: 1, h: end - start }
                    : { key: `sy:${line}:${from}`, axis, line, virtual: false, x: start, y: at, w: end - start, h: 1 });
            }
        }
    }
    return out;
}
/**
 * Where a boundary can be grabbed.
 *
 * Only where cards break on the line — elsewhere a card spans across it and
 * there is nothing between two things to take hold of. The grab area is kept
 * apart from the corridor so a zero gap is still grabbable.
 */
export function dividers(plane, grabSize) {
    const out = [];
    const hit = Math.max(plane.gap, grabSize);
    const frame = frameOf(plane);
    for (const axis of AXES) {
        const along = frame[axis].at;
        const other = axis === 'x' ? 'y' : 'x';
        const meet = touching(plane, axis);
        for (const line of interiorLines(plane, axis)) {
            for (const [from, to] of boundarySpans(plane, axis, line, meet)) {
                const start = frame[other].at[from] + frame[other].half[from];
                const end = frame[other].at[to] - frame[other].half[to];
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
/** Every axis a card is measured on, for a caller that treats both alike. */
