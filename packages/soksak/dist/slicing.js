/**
 * The fill of a close: the side whose neighbour takes the space of a closing
 * card, the span key it grows by, and the order of the sides.
 */
export const DIRECTIONS = {
    below: { side: 'below', grow: 'r0', touches: (c, x) => c.r0 === x.r1 },
    above: { side: 'above', grow: 'r1', touches: (c, x) => c.r1 === x.r0 },
    right: { side: 'right', grow: 'c0', touches: (c, x) => c.c0 === x.c1 },
    left: { side: 'left', grow: 'c1', touches: (c, x) => c.c1 === x.c0 },
};
export const ORDER = {
    v: ['below', 'above', 'right', 'left'],
    h: ['right', 'left', 'below', 'above'],
};
