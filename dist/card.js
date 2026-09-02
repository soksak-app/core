/**
 * Card types.
 *
 * Every element on the plane is a card: sidebar, rail, and pane use one type.
 * A card occupies a span of slots on each axis.
 *
 * `fixed` sets whether the layout may split, close or move the card.
 * `width` and `height` set how many px a card is drawn at when the plane has
 * the room; otherwise the card takes a share of what is left.
 */
/** Span keys for an axis. */
export const SPAN = {
    x: ['c0', 'c1'],
    y: ['r0', 'r1'],
};
/** Span keys for the other axis. */
export const CROSS = {
    x: ['r0', 'r1'],
    y: ['c0', 'c1'],
};
export const AXES = ['x', 'y'];
export const axisOf = (side) => side === 'left' || side === 'right' ? 'x' : 'y';
/** True when the side is before the card on its axis. */
export const isAhead = (side) => side === 'left' || side === 'top';
/** Number of slots the card spans on an axis. */
export const spanOf = (card, axis) => {
    const [lo, hi] = SPAN[axis];
    return card[hi] - card[lo];
};
/** The px size set on an axis, or null when the card takes a share. */
export function fixedSize(card, axis) {
    if (spanOf(card, axis) !== 1)
        return null;
    const size = axis === 'x' ? card.width : card.height;
    return typeof size === 'number' && Number.isFinite(size) ? Math.max(0, size) : null;
}
