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
 * A slot a card holds at a fixed size contributes that size; the rest share what
 * is left, in the proportions the lines describe. Walking the slots in order is
 * what makes a card at the plane's edge and one standing between panes the same
 * case — the only difference is which slot it holds.
 */
export function slotSizes(plane, axis) {
    var _a;
    const a = lines(plane, axis);
    const [lo] = SPAN[axis];
    const count = a.length - 1;
    const held = new Array(count).fill(null);
    for (const card of plane.cards) {
        const size = fixedSize(card, axis);
        if (size === null)
            continue;
        const slot = card[lo];
        held[slot] = Math.max((_a = held[slot]) !== null && _a !== void 0 ? _a : 0, size);
    }
    let taken = 0;
    let sharedSpan = 0;
    for (let i = 0; i < count; i++) {
        if (held[i] !== null)
            taken += held[i];
        else
            sharedSpan += a[i + 1] - a[i];
    }
    const usable = Math.max(0, extent(plane, axis) - taken);
    const scale = sharedSpan > 1e-9 ? usable / sharedSpan : 0;
    return held.map((fixed, i) => (fixed !== null ? fixed : (a[i + 1] - a[i]) * scale));
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
export function inset(plane, axis, index, side) {
    const a = lines(plane, axis);
    const flush = side === 'lo' ? index === 0 : index === a.length - 1;
    return flush ? 0 : plane.gap / 2;
}
/** Where a card's edge falls in px. */
export function edgePos(plane, axis, index, side) {
    const at = linePos(plane, axis, index);
    const back = inset(plane, axis, index, side);
    return side === 'lo' ? at + back : at - back;
}
/** The rect of one card. Every rect in the library comes from here. */
export function rectOf(plane, card) {
    const x0 = edgePos(plane, 'x', card.c0, 'lo');
    const x1 = edgePos(plane, 'x', card.c1, 'hi');
    const y0 = edgePos(plane, 'y', card.r0, 'lo');
    const y1 = edgePos(plane, 'y', card.r1, 'hi');
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** Cards that span across a line. They are why a card cannot be placed on it. */
export function crossing(plane, axis, line) {
    const [lo, hi] = SPAN[axis];
    return plane.cards.filter((c) => c[lo] < line && c[hi] > line);
}
/**
 * Index stretches where cards actually break on a line.
 *
 * A line runs the whole plane, but it is only a boundary where one card ends and
 * another begins. Everywhere else a card spans across it, and there is nothing
 * there to grab or to draw solid.
 */
export function boundarySpans(plane, axis, line) {
    const [lo, hi] = SPAN[axis];
    const [o0, o1] = CROSS[axis];
    const spans = [];
    for (const before of plane.cards) {
        if (before[hi] !== line)
            continue;
        for (const after of plane.cards) {
            if (after[lo] !== line)
                continue;
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
export function zoneAt(plane, x, y, options = {}) {
    var _a, _b, _c;
    const header = (_a = options.headerPx) !== null && _a !== void 0 ? _a : 0;
    const footer = (_b = options.footerPx) !== null && _b !== void 0 ? _b : 0;
    const edge = (_c = options.edge) !== null && _c !== void 0 ? _c : 0.25;
    for (const card of plane.cards) {
        const r = rectOf(plane, card);
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
export const axes = AXES;
