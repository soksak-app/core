/**
 * Fair sizes for an arrangement that is kept.
 *
 * An arrangement built by splitting is a slicing floorplan, so it reads as a
 * slicing tree. A card counts one along each axis; a cut along an axis counts
 * the sum of its sides, and a cut along the other axis counts the side that
 * holds the most. Each cut gives its sides space in proportion to that count,
 * so every card in the row that holds the most cards is drawn at the same size
 * and a card that spans several of them is drawn across them.
 *
 * A card with a px size on an axis keeps the size it is drawn at and counts
 * nothing there; the others share what is left.
 */
import { SPAN, fixedSize } from './card.js';
/**
 * The slicing tree of an arrangement, or null when it is not slicing.
 *
 * Every line one cut can divide the cards at is taken at once, so the sides of
 * a cut along an axis are the cards between two of those lines.
 */
export function sliceTree(cards) {
    if (cards.length === 1)
        return { card: cards[0] };
    for (const axis of ['x', 'y']) {
        const [lo, hi] = SPAN[axis];
        const start = Math.min(...cards.map((c) => c[lo]));
        const end = Math.max(...cards.map((c) => c[hi]));
        const cuts = [...new Set(cards.map((c) => c[hi]))]
            .filter((at) => at < end && cards.every((c) => c[hi] <= at || c[lo] >= at))
            .sort((a, b) => a - b);
        if (!cuts.length)
            continue;
        const bounds = [start, ...cuts, end];
        const sides = [];
        for (let i = 0; i + 1 < bounds.length; i++) {
            const side = sliceTree(cards.filter((c) => c[lo] >= bounds[i] && c[hi] <= bounds[i + 1]));
            if (!side)
                return null;
            sides.push(side);
        }
        return { axis, sides };
    }
    return null;
}
/** How many fair shares a slice takes along an axis. */
export function weight(slice, axis) {
    if ('card' in slice)
        return fixedSize(slice.card, axis) === null ? 1 : 0;
    const counts = slice.sides.map((side) => weight(side, axis));
    return slice.axis === axis ? counts.reduce((a, b) => a + b, 0) : Math.max(...counts);
}
const EDGES = {
    x: ['left', 'right'],
    y: ['top', 'bottom'],
};
const ENDS = {
    x: ['x0', 'x1'],
    y: ['y0', 'y1'],
};
/**
 * The region of every card once the slice is balanced inside `region`.
 *
 * `drawn` is the size a card with a px size is drawn at on an axis; `gap` is the
 * corridor between two neighbours, which each of them gives half of.
 */
export function balanceRegions(slice, region, gap, drawn, out = new Map()) {
    if ('card' in slice) {
        out.set(slice.card.id, region);
        return out;
    }
    const axis = slice.axis;
    const [startEdge, endEdge] = EDGES[axis];
    const [from, to] = ENDS[axis];
    const half = gap / 2;
    const count = slice.sides.length;
    const held = slice.sides.map((side) => 'card' in side && fixedSize(side.card, axis) !== null ? drawn(side.card, axis) : null);
    const shares = slice.sides.map((side) => weight(side, axis));
    // The drawn size of the cards in the region: its extent less the corridors at
    // its edges that face a neighbour.
    const content = region[to] - region[from] - (region[startEdge] ? 0 : half) - (region[endEdge] ? 0 : half);
    let free = content - (count - 1) * gap;
    let total = 0;
    slice.sides.forEach((_, i) => {
        if (held[i] !== null)
            free -= held[i];
        else {
            free -= Math.max(0, shares[i] - 1) * gap;
            total += shares[i];
        }
    });
    const unit = total > 0 ? Math.max(0, free) / total : 0;
    let cursor = region[from];
    slice.sides.forEach((side, i) => {
        const first = i === 0;
        const last = i === count - 1;
        const own = held[i];
        const size = own !== null ? own : shares[i] * unit + Math.max(0, shares[i] - 1) * gap;
        const extent = size + (first && region[startEdge] ? 0 : half) + (last && region[endEdge] ? 0 : half);
        const part = { ...region, [from]: cursor, [to]: last ? region[to] : cursor + extent };
        part[startEdge] = first && region[startEdge];
        part[endEdge] = last && region[endEdge];
        balanceRegions(side, part, gap, drawn, out);
        cursor += extent;
    });
    return out;
}
