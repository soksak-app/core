/**
 * A card, and what a role means.
 *
 * Everything on the plane is a card — a sidebar, a rail, a terminal. One type,
 * one rect rule, one corridor, one radius, one outline. A role is one answer:
 * whether the layout moves it — split, close and move, or never. A card may
 * also carry a `width`, which is an attribute and not a second kind of card.
 *
 * That is what makes a sidebar and a terminal the same object. A sidebar at the
 * window's edge is a card holding the first column; the same card holding a
 * middle column is a rail standing between panes. There is no second kind of
 * thing to keep in step, and no line to check — a card occupies its columns, so
 * nothing can cross it.
 */
/** The pair of span keys an axis is measured by. */
export const SPAN = {
    x: ['c0', 'c1'],
    y: ['r0', 'r1'],
};
/** The pair for the other axis — a card's extent across the one being measured. */
export const CROSS = {
    x: ['r0', 'r1'],
    y: ['c0', 'c1'],
};
export const AXES = ['x', 'y'];
export const axisOf = (side) => side === 'left' || side === 'right' ? 'x' : 'y';
/** Whether a side lands ahead of the card it names. */
export const isAhead = (side) => side === 'left' || side === 'top';
/** How many slots a card spans along an axis. One means it can hold that slot. */
export const spanOf = (card, axis) => {
    const [lo, hi] = SPAN[axis];
    return card[hi] - card[lo];
};
/** The fixed size a card declares along an axis, or null when it takes a share. */
export function fixedSize(card, axis) {
    if (spanOf(card, axis) !== 1)
        return null;
    const size = axis === 'x' ? card.width : card.height;
    return typeof size === 'number' && Number.isFinite(size) ? Math.max(0, size) : null;
}
