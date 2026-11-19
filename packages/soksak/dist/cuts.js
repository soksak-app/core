/**
 * Even shares over the cuts of the slicing tree (packages/soksak/docs/layout.md#cuts).
 *
 * A cut divides a rectangle along one axis into children: cards, boxes of the
 * host and cuts along the other axis. `even` gives every child of every cut an
 * equal size. A size is a drawn size, the extent of the drawn rectangles of a
 * child less on the y axis the heads above it, and the grid draws a slot at its
 * span of the whole plane less its corridor, so a size is not a span: a plan
 * lays every cut by equal spans, the grid draws the result, and `correct` moves
 * each span by the difference between the size drawn and the equal size. A
 * corridor does not change with the span, so one correction lays the sizes
 * exactly; a nested cut takes one more. Coordinates within a billionth are one
 * line (R1).
 */
const ENDS = { x: ['x0', 'x1'], y: ['y0', 'y1'] };
const extentOf = (cells, card) => ({
    x0: cells.xs[card.c0], x1: cells.xs[card.c1], y0: cells.ys[card.r0], y1: cells.ys[card.r1],
});
const union = (extents) => ({
    x0: Math.min(...extents.map((e) => e.x0)),
    x1: Math.max(...extents.map((e) => e.x1)),
    y0: Math.min(...extents.map((e) => e.y0)),
    y1: Math.max(...extents.map((e) => e.y1)),
});
/** Whether a card keeps its span on an axis: fixed, or drawn at a px size there (R2). */
function holds(card, axis) {
    if (card.fixed)
        return true;
    const span = axis === 'x' ? card.c1 - card.c0 : card.r1 - card.r0;
    const size = axis === 'x' ? card.width : card.height;
    return size !== undefined && span === 1;
}
/** The tree of a set of children, the cut along x taken first where the lines allow both. */
function build(nodes) {
    if (nodes.length === 1)
        return nodes[0];
    for (const axis of ['x', 'y']) {
        const [lo, hi] = ENDS[axis];
        const end = Math.max(...nodes.map((n) => n.old[hi]));
        const at = [...new Set(nodes.map((n) => n.old[hi]))]
            .filter((v) => v < end && nodes.every((n) => n.old[hi] <= v || n.old[lo] >= v))
            .sort((a, b) => a - b);
        if (!at.length)
            continue;
        const bounds = [Math.min(...nodes.map((n) => n.old[lo])), ...at, end];
        const kids = [];
        for (let i = 0; i + 1 < bounds.length; i++) {
            kids.push(build(nodes.filter((n) => n.old[lo] >= bounds[i] && n.old[hi] <= bounds[i + 1])));
        }
        const old = union(kids.map((k) => k.old));
        return { kind: 'cut', axis, kids, old, rect: old, above: 0, adjust: kids.map(() => 0) };
    }
    throw new Error('the grid is not a slicing arrangement');
}
/** The card ids inside a box, through the boxes that it holds. */
function contentsOf(box) {
    return box.members.flatMap((member) => (typeof member === 'string' ? [member] : contentsOf(member)));
}
/** The leaves of the members of one box or of the plane. */
function leaves(members, cells, byId) {
    return members.map((member) => {
        if (typeof member === 'string') {
            const card = byId.get(member);
            if (!card)
                throw new Error(`card ${member} is not a member of the layout`);
            const old = extentOf(cells, card);
            return { kind: 'leaf', card, box: null, inner: null, held: { x: holds(card, 'x'), y: holds(card, 'y') }, old, rect: old, above: 0 };
        }
        const inside = contentsOf(member).map((id) => byId.get(id));
        if (!inside.length || inside.some((card) => !card))
            throw new Error(`card ${member.id} is not a member of the layout`);
        const old = union(inside.map((card) => extentOf(cells, card)));
        const inner = build(leaves(member.members, cells, byId));
        return { kind: 'leaf', card: null, box: member, inner, held: { x: false, y: false }, old, rect: old, above: 0 };
    });
}
const isHeld = (node, axis) => node.kind === 'leaf' && node.held[axis];
/** Lays a node into its rectangle: every cut gives its children that keep no span equal spans and their corrections. */
function place(node, rect, above) {
    node.rect = rect;
    node.above = above;
    if (node.kind === 'leaf') {
        if (node.inner)
            place(node.inner, rect, above + node.box.head);
        return;
    }
    const axis = node.axis;
    const [lo, hi] = ENDS[axis];
    const spans = node.kids.map((kid) => kid.old[hi] - kid.old[lo]);
    let free = rect[hi] - rect[lo];
    node.kids.forEach((kid, i) => {
        if (isHeld(kid, axis))
            free -= spans[i];
    });
    const sharing = node.kids.filter((kid) => !isHeld(kid, axis)).length;
    node.kids.forEach((kid, i) => {
        if (!isHeld(kid, axis) && sharing > 0)
            spans[i] = Math.max(0, Math.max(0, free) / sharing + node.adjust[i]);
    });
    let at = rect[lo];
    node.kids.forEach((kid, i) => {
        const end = i === node.kids.length - 1 ? rect[hi] : at + spans[i];
        place(kid, { ...rect, [lo]: at, [hi]: end }, axis === 'x' || i === 0 ? above : 0);
        at = end;
    });
}
/** The card leaves of a node. */
function cardsOf(node) {
    if (node.kind === 'cut')
        return node.kids.flatMap(cardsOf);
    if (node.inner)
        return cardsOf(node.inner);
    return [node];
}
/** The distance under which two coordinates of the laid tree are one line, as the grid compares its lines. */
const EPS = 1e-9;
/**
 * The lines of coordinates: coordinates within EPS of the line before are that line, because two cuts laid alike, such as two rows of
 * equal shares, reach one coordinate through different sums.
 */
function linesOf(values) {
    const out = [];
    for (const v of [...values].sort((a, b) => a - b))
        if (!out.length || v - out[out.length - 1] >= EPS)
            out.push(v);
    return out;
}
/** The index of the line of v. */
const lineOf = (lines, v) => lines.filter((line) => line <= v + EPS).length - 1;
/** The cells of the laid tree: coordinates within EPS are one line, and the cards keep their order. */
function cellsOf(root, order) {
    const laid = cardsOf(root);
    const xs = linesOf(laid.flatMap((c) => [c.rect.x0, c.rect.x1]));
    const ys = linesOf(laid.flatMap((c) => [c.rect.y0, c.rect.y1]));
    const at = new Map(laid.map((leaf) => [leaf.card.id, leaf.rect]));
    const cards = order.map((card) => {
        const r = at.get(card.id);
        return { ...card, c0: lineOf(xs, r.x0), c1: lineOf(xs, r.x1), r0: lineOf(ys, r.y0), r1: lineOf(ys, r.y1) };
    });
    return { xs, ys, cards };
}
/** Moves each span by the difference between the drawn size of its child and the equal size, and returns the largest difference in px. */
function correct(root, drawn, rate) {
    let worst = 0;
    const visit = (node) => {
        if (node.kind === 'leaf') {
            if (node.inner)
                visit(node.inner);
            return;
        }
        node.kids.forEach(visit);
        const axis = node.axis;
        const each = rate(axis);
        const sharing = node.kids.map((_, i) => i).filter((i) => !isHeld(node.kids[i], axis));
        if (!(each > 0) || !sharing.length)
            return;
        const sizes = node.kids.map((kid) => {
            const rects = cardsOf(kid).map((leaf) => drawn.get(leaf.card.id));
            const start = Math.min(...rects.map((r) => (axis === 'x' ? r.x : r.y)));
            const end = Math.max(...rects.map((r) => (axis === 'x' ? r.x + r.w : r.y + r.h)));
            return end - start - (axis === 'y' ? kid.above : 0);
        });
        const want = sharing.reduce((a, i) => a + sizes[i], 0) / sharing.length;
        for (const i of sharing) {
            const error = sizes[i] - want;
            worst = Math.max(worst, Math.abs(error));
            node.adjust[i] -= error / each;
        }
    };
    visit(root);
    return worst;
}
/**
 * The plan that gives every child of every cut an equal size. The cards that no box holds and the boxes are the members of the plane;
 * the members of a box have a tree of their own inside its rectangle, so no cut crosses a box.
 */
export function evenCuts(cells, boxes) {
    const byId = new Map(cells.cards.map((card) => [card.id, card]));
    const boxed = new Set(boxes.flatMap(contentsOf));
    const members = [...cells.cards.filter((card) => !boxed.has(card.id)).map((card) => card.id), ...boxes];
    const root = build(leaves(members, cells, byId));
    return {
        layout: () => {
            place(root, root.old, 0);
            return cellsOf(root, cells.cards);
        },
        correct: (drawn, rate) => correct(root, drawn, rate),
    };
}
