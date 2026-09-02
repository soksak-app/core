/**
 * Slicing check and fill selection.
 *
 * Splitting replaces one card with two, so an arrangement built by splitting is
 * always a slicing floorplan: one a single cut can divide in two, recursively.
 * A close must leave it slicing, or cards appear that no neighbour can fill.
 *
 * `isSlicing` answers that. `fillFor` picks the row of neighbours that grows
 * over a closing card.
 */
import { SPAN } from './card.js';
const key = (list) => list
    .map((r) => `${r.c0},${r.c1},${r.r0},${r.r1}`)
    .sort()
    .join('|');
/**
 * Whether one cut can divide the regions in two, all the way down.
 *
 * Memoised because a close asks it once per candidate side, and the same
 * arrangement comes back constantly during a drag.
 */
export function isSlicing(list, memo = new Map()) {
    const k = key(list);
    const hit = memo.get(k);
    if (hit !== undefined)
        return hit;
    let answer = list.length <= 1;
    if (!answer) {
        outer: for (const axis of ['x', 'y']) {
            const [lo, hi] = SPAN[axis];
            for (const at of new Set(list.map((r) => r[hi]))) {
                const before = list.filter((r) => r[hi] <= at);
                const after = list.filter((r) => r[lo] >= at);
                if (!before.length || !after.length)
                    continue;
                if (before.length + after.length !== list.length)
                    continue;
                if (isSlicing(before, memo) && isSlicing(after, memo)) {
                    answer = true;
                    break outer;
                }
            }
        }
    }
    if (memo.size > 4000)
        memo.clear();
    memo.set(k, answer);
    return answer;
}
const DIRECTIONS = {
    below: { side: 'below', grow: 'r0', touches: (c, x) => c.r0 === x.r1, lo: 'c0', hi: 'c1' },
    above: { side: 'above', grow: 'r1', touches: (c, x) => c.r1 === x.r0, lo: 'c0', hi: 'c1' },
    right: { side: 'right', grow: 'c0', touches: (c, x) => c.c0 === x.c1, lo: 'r0', hi: 'r1' },
    left: { side: 'left', grow: 'c1', touches: (c, x) => c.c1 === x.c0, lo: 'r0', hi: 'r1' },
};
const ORDER = {
    v: ['below', 'above', 'right', 'left'],
    h: ['right', 'left', 'below', 'above'],
};
/**
 * Which neighbours take a closed card's space.
 *
 * A row of neighbours may tile the side together. The result must still be
 * slicing, which keeps every card closable.
 *
 * A `fixed` card never fills, since the layout may not grow it. A card with a
 * px size does fill; spanning a second slot drops that size.
 */
export function fillFor(cards, closing, order, memo) {
    if (closing.fixed)
        return null;
    if (cards.filter((c) => !c.fixed).length <= 1)
        return null;
    for (const side of ORDER[order]) {
        const dir = DIRECTIONS[side];
        const row = cards
            .filter((c) => c !== closing &&
            !c.fixed &&
            dir.touches(c, closing) &&
            c[dir.lo] >= closing[dir.lo] &&
            c[dir.hi] <= closing[dir.hi])
            .sort((a, b) => a[dir.lo] - b[dir.lo]);
        if (!row.length)
            continue;
        let at = closing[dir.lo];
        let tiles = true;
        for (const card of row) {
            if (card[dir.lo] !== at) {
                tiles = false;
                break;
            }
            at = card[dir.hi];
        }
        if (!tiles || at !== closing[dir.hi])
            continue;
        const after = cards
            .filter((c) => c !== closing)
            .map((c) => {
            const span = { c0: c.c0, c1: c.c1, r0: c.r0, r1: c.r1 };
            if (row.includes(c))
                span[dir.grow] = closing[dir.grow];
            return span;
        });
        if (isSlicing(after, memo))
            return { side, grow: dir.grow, cards: row };
    }
    return null;
}
