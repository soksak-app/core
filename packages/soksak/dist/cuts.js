/**
 * The two primitives of the rule of sizes over the slicing tree, and even shares
 * (packages/soksak/docs/layout.md#cuts).
 *
 * A cut divides a rectangle along one axis into children: cards, boxes of the
 * host and cuts along the other axis. REMOVE (`withdraw`) takes a member out of
 * its cut, and the other children take its space in proportion to their sizes.
 * ADD (`insert`) puts a card beside a target: along the cut of the target, an
 * even cut gives the card 1/(k+1) and keeps every ratio, and a cut that is not
 * even takes half of the target for the card and keeps every other size; across
 * it, the target is wrapped in a new cut of two halves. `even` gives every child
 * of every cut an equal share.
 *
 * A size is a drawn size, the extent of the drawn rectangles of a child less on
 * the y axis the heads above it, and the library draws a slot at its span of the
 * whole plane less its corridor, so a size is not a span. An operation returns a
 * plan: `layout` lays the changed cuts by their weights, the grid draws the
 * result, and `correct` moves each laid span by the difference between the size
 * drawn and the size the weights ask for. Only the children of a cut that an
 * operation changes are laid again; every other card keeps its coordinates, and
 * coordinates within a billionth are one line (R1). `minimum` judges the result:
 * a node whose rectangle changed is refused below its minimum, computed
 * recursively with heads and corridors as fixed costs.
 */
import { axisOf } from './card.js';
const SIDES = ['left', 'right', 'top', 'bottom'];
const ENDS = { x: ['x0', 'x1'], y: ['y0', 'y1'] };
const bare = (card) => {
    const { c0: _c0, c1: _c1, r0: _r0, r1: _r1, ...rest } = card;
    return rest;
};
const extentOf = (cells, card) => ({
    x0: cells.xs[card.c0], x1: cells.xs[card.c1], y0: cells.ys[card.r0], y1: cells.ys[card.r1],
});
const union = (extents) => ({
    x0: Math.min(...extents.map((e) => e.x0)),
    x1: Math.max(...extents.map((e) => e.x1)),
    y0: Math.min(...extents.map((e) => e.y0)),
    y1: Math.max(...extents.map((e) => e.y1)),
});
/** The drawn extent per axis of a set of drawn rectangles. */
const sizeOf = (rects) => ({
    x: Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x)),
    y: Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y)),
});
/** Whether a card keeps its span on an axis: fixed, or drawn at a px size there (R2). */
function holds(card, spans, axis) {
    if (card.fixed)
        return true;
    const size = axis === 'x' ? card.width : card.height;
    return size !== undefined && spans[axis] === 1;
}
function cut(axis, kids, dirty) {
    const old = union(kids.map((k) => k.old));
    const along = kids.reduce((a, k) => a + k.size[axis], 0);
    const other = axis === 'x' ? 'y' : 'x';
    const size = { [axis]: along, [other]: Math.max(...kids.map((k) => k.size[other])) };
    return {
        kind: 'cut', axis, kids, old, rect: old, size, above: kids[0].above, placedAbove: 0, weight: null, dirty, laid: false,
        adjust: kids.map(() => 0),
    };
}
/** The tree of a set of children, the cut of `prefer[0]` taken first where the lines allow both. */
function build(nodes, prefer) {
    if (nodes.length === 1)
        return nodes[0];
    for (const axis of prefer) {
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
            kids.push(build(nodes.filter((n) => n.old[lo] >= bounds[i] && n.old[hi] <= bounds[i + 1]), prefer));
        }
        return cut(axis, kids, false);
    }
    throw new Error('the grid is not a slicing arrangement');
}
/** Sets the px of the heads above each node where it stands: the children of a cut along x share it, a cut along y gives it to its first child. */
function assignAbove(node, above) {
    node.above = above;
    if (node.kind === 'leaf') {
        if (node.inner)
            assignAbove(node.inner, above + node.box.head);
        return;
    }
    node.kids.forEach((kid, i) => assignAbove(kid, node.axis === 'x' || i === 0 ? above : 0));
}
function cardLeaf(card, old, spans, rect) {
    return {
        kind: 'leaf', id: card.id, card, box: null, inner: null, held: { x: holds(card, spans, 'x'), y: holds(card, spans, 'y') },
        old, rect: old, size: sizeOf([rect]), above: 0, placedAbove: 0, weight: null,
    };
}
function boxLeaf(box, inner, old, rects) {
    return {
        kind: 'leaf', id: box.id, card: null, box, inner, held: { x: false, y: false }, old, rect: old, size: sizeOf(rects), above: 0,
        placedAbove: 0, weight: null,
    };
}
/** The card ids inside a box, through the boxes that it holds. */
function contentsOf(box) {
    return box.members.flatMap((member) => (typeof member === 'string' ? [member] : contentsOf(member)));
}
/** The leaves of the members of one box or of the plane, read from the cells and their drawn rectangles. */
function leaves(members, cells, byId, drawn, prefer) {
    return members.map((member) => {
        if (typeof member === 'string') {
            const card = byId.get(member);
            if (!card)
                throw new Error(`card ${member} is not a member of the layout`);
            return cardLeaf(bare(card), extentOf(cells, card), { x: card.c1 - card.c0, y: card.r1 - card.r0 }, drawn.get(member));
        }
        const inside = contentsOf(member).map((id) => byId.get(id));
        if (!inside.length || inside.some((card) => !card))
            throw new Error(`card ${member.id} is not a member of the layout`);
        const cards = inside;
        const inner = build(leaves(member.members, cells, byId, drawn, prefer), prefer);
        return boxLeaf(member, inner, union(cards.map((card) => extentOf(cells, card))), cards.map((card) => drawn.get(card.id)));
    });
}
/** The tree of the plane: the cards that no box holds and the boxes, each box with the tree of its members. */
function planeTree(cells, boxes, drawn, prefer) {
    const byId = new Map(cells.cards.map((card) => [card.id, card]));
    const boxed = new Set(boxes.flatMap(contentsOf));
    const members = [...cells.cards.filter((card) => !boxed.has(card.id)).map((card) => card.id), ...boxes];
    const root = build(leaves(members, cells, byId, drawn, prefer), prefer);
    assignAbove(root, 0);
    return root;
}
function find(root, id, owner = null, holder = null) {
    if (root.kind === 'leaf') {
        if (root.id === id)
            return { node: root, cut: holder, owner };
        return root.inner ? find(root.inner, id, root, null) : null;
    }
    for (const kid of root.kids) {
        const hit = find(kid, id, owner, root);
        if (hit)
            return hit;
    }
    return null;
}
/** The ids of the leaves of a node in its own tree, without the members inside its boxes. */
function members(node) {
    return node.kind === 'leaf' ? [node.id] : node.kids.flatMap(members);
}
/** The cut that holds `node` in the tree rooted at `root`, or null. */
function parent(root, node) {
    if (root.kind === 'leaf')
        return null;
    for (const kid of root.kids) {
        if (kid === node)
            return root;
        const hit = parent(kid, node);
        if (hit)
            return hit;
    }
    return null;
}
/** The size of a node among the children of a cut along `axis`: its drawn extent, less on y the heads above it. */
const sizeAlong = (node, axis) => node.size[axis] - (axis === 'y' ? node.above : 0);
const isHeld = (node, axis) => node.kind === 'leaf' && node.held[axis];
const weightOf = (node, axis) => { var _a; return (_a = node.weight) !== null && _a !== void 0 ? _a : sizeAlong(node, axis); };
/** Lays a node into its rectangle, and the children of a cut that changed or whose rectangle moved on its axis by their weights. */
function place(node, rect, above) {
    node.rect = rect;
    node.placedAbove = above;
    if (node.kind === 'leaf') {
        if (node.inner)
            place(node.inner, rect, above + node.box.head);
        return;
    }
    const axis = node.axis;
    const [lo, hi] = ENDS[axis];
    const kept = !node.dirty && rect[lo] === node.old[lo] && rect[hi] === node.old[hi] && above === node.above;
    node.laid = !kept;
    const spans = node.kids.map((kid) => kid.old[hi] - kid.old[lo]);
    if (!kept) {
        let free = rect[hi] - rect[lo];
        node.kids.forEach((kid, i) => {
            if (isHeld(kid, axis))
                free -= spans[i];
        });
        const sharing = node.kids.filter((kid) => !isHeld(kid, axis));
        const total = sharing.reduce((a, kid) => a + weightOf(kid, axis), 0);
        node.kids.forEach((kid, i) => {
            if (isHeld(kid, axis))
                return;
            const share = total > 0 ? weightOf(kid, axis) / total : 1 / sharing.length;
            spans[i] = Math.max(0, Math.max(0, free) * share + node.adjust[i]);
        });
    }
    let at = rect[lo];
    node.kids.forEach((kid, i) => {
        const last = i === node.kids.length - 1;
        const from = kept ? kid.old[lo] : at;
        const end = kept ? kid.old[hi] : last ? rect[hi] : at + spans[i];
        place(kid, { ...rect, [lo]: from, [hi]: end }, axis === 'x' || i === 0 ? above : 0);
        at = end;
    });
}
/** The cards of a node with the coordinates that `place` gave them, or that they had. */
function cardsOf(node, laid) {
    if (node.kind === 'cut')
        return node.kids.flatMap((kid) => cardsOf(kid, laid));
    if (node.inner)
        return cardsOf(node.inner, laid);
    return [{ card: node.card, at: laid ? node.rect : node.old }];
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
/** The cells of the laid tree: coordinates within EPS are one line, and the cards keep the order of `order` with the new ones after. */
function cellsOf(root, order) {
    const laid = cardsOf(root, true);
    const xs = linesOf(laid.flatMap((c) => [c.at.x0, c.at.x1]));
    const ys = linesOf(laid.flatMap((c) => [c.at.y0, c.at.y1]));
    const rank = (id) => {
        const at = order.indexOf(id);
        return at < 0 ? order.length : at;
    };
    laid.sort((a, b) => rank(a.card.id) - rank(b.card.id));
    const cards = laid.map(({ card, at }) => ({
        ...card, c0: lineOf(xs, at.x0), c1: lineOf(xs, at.x1), r0: lineOf(ys, at.y0), r1: lineOf(ys, at.y1),
    }));
    return { xs, ys, cards };
}
/** Moves each span that the last layout laid by the difference between its drawn size and the size its weight asks for. */
function correct(root, drawn, rate) {
    let worst = 0;
    const visit = (node) => {
        if (node.kind === 'leaf') {
            if (node.inner)
                visit(node.inner);
            return;
        }
        node.kids.forEach(visit);
        if (!node.laid)
            return;
        const axis = node.axis;
        const each = rate(axis);
        if (!(each > 0))
            return;
        const sharing = node.kids.map((kid, i) => i).filter((i) => !isHeld(node.kids[i], axis));
        const sizes = node.kids.map((kid) => {
            const rects = cardsOf(kid, true).map((c) => drawn.get(c.card.id));
            return sizeOf(rects)[axis] - (axis === 'y' ? kid.placedAbove : 0);
        });
        const total = sharing.reduce((a, i) => a + weightOf(node.kids[i], axis), 0);
        const room = sharing.reduce((a, i) => a + sizes[i], 0);
        for (const i of sharing) {
            const want = total > 0 ? (room * weightOf(node.kids[i], axis)) / total : room / sharing.length;
            const error = sizes[i] - want;
            worst = Math.max(worst, Math.abs(error));
            node.adjust[i] -= error / each;
        }
    };
    visit(root);
    return worst;
}
/** The node of what arrives: a new card, or a card or a box that left, with the tree of its members at the place it left. */
function arrivingNode(card) {
    if (!('cards' in card)) {
        const fresh = { id: card.id, fixed: false, ...(card.data !== undefined ? { data: card.data } : {}) };
        const none = { x0: 0, x1: 0, y0: 0, y1: 0 };
        return cardLeaf(fresh, none, { x: 1, y: 1 }, { x: 0, y: 0, w: 0, h: 0 });
    }
    if (!card.box) {
        const [only] = card.cards;
        const leaf = cardLeaf(only.card, { x0: only.x0, x1: only.x1, y0: only.y0, y1: only.y1 }, { x: 1, y: 1 }, only.rect);
        leaf.above = card.above;
        return leaf;
    }
    const xs = [...new Set(card.cards.flatMap((c) => [c.x0, c.x1]))].sort((a, b) => a - b);
    const ys = [...new Set(card.cards.flatMap((c) => [c.y0, c.y1]))].sort((a, b) => a - b);
    const cells = {
        xs, ys,
        cards: card.cards.map((c) => ({ ...c.card, c0: xs.indexOf(c.x0), c1: xs.indexOf(c.x1), r0: ys.indexOf(c.y0), r1: ys.indexOf(c.y1) })),
    };
    const byId = new Map(cells.cards.map((c) => [c.id, c]));
    const drawn = new Map(card.cards.map((c) => [c.card.id, c.rect]));
    const prefer = ['x', 'y'];
    const inner = build(leaves(card.box.members, cells, byId, drawn, prefer), prefer);
    const leaf = boxLeaf(card.box, inner, union(card.cards.map(({ x0, x1, y0, y1 }) => ({ x0, x1, y0, y1 }))), card.cards.map((c) => c.rect));
    assignAbove(leaf, card.above);
    // The members of the box are laid again in its new rectangle by the sizes they had.
    const mark = (node) => {
        if (node.kind === 'leaf')
            return;
        node.dirty = true;
        node.kids.forEach(mark);
    };
    mark(inner);
    return leaf;
}
/** The ids that a state and its boxes hold: every card and every box. */
function ids(cells, boxes) {
    const out = new Set(cells.cards.map((card) => card.id));
    const walk = (box) => {
        out.add(box.id);
        box.members.forEach((m) => {
            if (typeof m !== 'string')
                walk(m);
        });
    };
    boxes.forEach(walk);
    return out;
}
/** Puts `next` where the found node stood: in its cut, or as the root of the tree of a box or of the plane. */
function replaceNode(tree, found, next) {
    if (found.cut)
        found.cut.kids[found.cut.kids.indexOf(found.node)] = next;
    else if (found.owner)
        found.owner.inner = next;
    else
        tree.root = next;
}
/**
 * The target of an insert: the node of one member, or the neighbouring children of one cut that hold exactly the members of the list,
 * which become a cut of their own inside it.
 */
function targetNode(tree, target) {
    const list = typeof target === 'string' ? [target] : [...target];
    const hits = list.map((id) => {
        const hit = find(tree.root, id);
        if (!hit)
            throw new Error(`card ${id} is not a member of the layout`);
        return hit;
    });
    if (list.length === 1)
        return hits[0];
    const refused = () => new Error(`cards ${list.join(', ')} are not neighbours of one cut`);
    const owner = hits[0].owner;
    const root = owner ? owner.inner : tree.root;
    let holder = null;
    for (let at = hits[0].node; at; at = parent(root, at)) {
        const node = at;
        if (node.kind === 'cut' && list.every((id) => members(node).includes(id))) {
            holder = node;
            break;
        }
    }
    if (!holder)
        throw refused();
    const level = holder;
    const touched = level.kids.map((kid, i) => (members(kid).some((id) => list.includes(id)) ? i : -1)).filter((i) => i >= 0);
    const first = touched[0];
    const last = touched[touched.length - 1];
    const span = level.kids.slice(first, last + 1);
    const held = span.flatMap(members);
    if (held.length !== list.length || !held.every((id) => list.includes(id)))
        throw refused();
    if (first === 0 && last === level.kids.length - 1)
        return { node: level, cut: parent(root, level), owner };
    const sub = cut(level.axis, span, false);
    sub.weight = span.reduce((a, k) => a + weightOf(k, level.axis), 0);
    level.kids.splice(first, span.length, sub);
    level.adjust = level.kids.map(() => 0);
    return { node: sub, cut: level, owner };
}
/** The difference in px under which the sizes of the children of a cut are equal, so the cut is even. */
const EVEN = 0.5;
/** Whether the children of a cut that keep no span on its axis have one size. */
function isEven(into) {
    const sizes = into.kids.filter((kid) => !isHeld(kid, into.axis)).map((kid) => weightOf(kid, into.axis));
    return sizes.every((size) => Math.abs(size - sizes[0]) < EVEN);
}
/**
 * Adds the node `arriving` beside the found node toward `side`. Along the cut of the target, an even cut gives it 1/(k+1) and keeps
 * every ratio; a cut that is not even takes half of the target less the new corridor, `gap`, the child toward `side` when the target
 * is the cut itself, and keeps every other size. Across the cut, the target is wrapped in a new cut of two halves.
 */
function addBeside(tree, found, side, arriving, gap) {
    const axis = axisOf(side);
    const after = side === 'right' || side === 'bottom';
    const { node, cut: holder } = found;
    const insertInto = (into, at, payer) => {
        const sharing = into.kids.filter((kid) => !isHeld(kid, axis));
        const even = isEven(into);
        sharing.forEach((kid) => {
            kid.weight = weightOf(kid, axis);
        });
        if (even || isHeld(payer, axis)) {
            const total = sharing.reduce((a, kid) => a + kid.weight, 0);
            arriving.weight = sharing.length ? total / sharing.length : 1;
        }
        else {
            // The new corridor comes out of the target too, so every other child keeps its drawn size.
            payer.weight = Math.max(0, payer.weight - gap) / 2;
            arriving.weight = payer.weight;
        }
        into.kids.splice(at, 0, arriving);
        into.adjust = into.kids.map(() => 0);
        into.dirty = true;
    };
    if (node.kind === 'cut' && node.axis === axis) {
        insertInto(node, after ? node.kids.length : 0, after ? node.kids[node.kids.length - 1] : node.kids[0]);
        return;
    }
    if (holder && holder.axis === axis) {
        insertInto(holder, holder.kids.indexOf(node) + (after ? 1 : 0), node);
        return;
    }
    const weight = holder ? weightOf(node, holder.axis) : null;
    node.weight = 1;
    arriving.weight = 1;
    const next = cut(axis, after ? [node, arriving] : [arriving, node], true);
    next.old = node.old;
    next.rect = node.old;
    next.size = node.size;
    next.above = node.above;
    next.weight = weight;
    replaceNode(tree, found, next);
}
/**
 * The size that a node needs on an axis, in the px of the grid rectangles: a card its minimum and on y the heads drawn inside its
 * rectangle; a box the need of its members; a cut along the axis the needs of its children and the corridors between them; a cut across
 * it the largest need of its children. A child that keeps its span needs the size it is drawn at.
 */
function need(node, axis, drawn, min) {
    const extent = (n) => sizeOf(cardsOf(n, true).map((c) => drawn.get(c.card.id)))[axis];
    if (node.kind === 'leaf') {
        if (node.inner)
            return need(node.inner, axis, drawn, min);
        if (node.held[axis])
            return extent(node);
        return min + (axis === 'y' ? node.placedAbove : 0);
    }
    const kids = node.kids.map((kid) => need(kid, axis, drawn, min));
    if (node.axis !== axis)
        return Math.max(...kids);
    const corridors = extent(node) - node.kids.reduce((a, kid) => a + extent(kid), 0);
    return kids.reduce((a, n) => a + n, 0) + corridors;
}
/** The text of the outermost node whose rectangle the plan changed and that is drawn below its minimum, or null. */
function belowMinimum(root, drawn, min) {
    const text = (n) => String(Math.round(n));
    const visit = (node) => {
        const moved = ['x0', 'x1', 'y0', 'y1'].some((key) => Math.abs(node.rect[key] - node.old[key]) > EPS);
        if (moved || (node.kind === 'cut' && node.laid)) {
            const has = sizeOf(cardsOf(node, true).map((c) => drawn.get(c.card.id)));
            const needs = { x: need(node, 'x', drawn, min), y: need(node, 'y', drawn, min) };
            if (node.kind === 'leaf' && (has.x < needs.x - EVEN || has.y < needs.y - EVEN)) {
                return `card ${node.id} would be ${text(has.x)}x${text(has.y)}, below its minimum ${text(needs.x)}x${text(needs.y)}`;
            }
        }
        if (node.kind === 'leaf')
            return node.inner ? visit(node.inner) : null;
        for (const kid of node.kids) {
            const found = visit(kid);
            if (found)
                return found;
        }
        return null;
    };
    return visit(root);
}
/** The tree for an operation toward `axis`: the cut across that axis is the outer one where the lines allow both. */
const across = (axis) => (axis === 'x' ? ['y', 'x'] : ['x', 'y']);
const planOf = (tree, order) => ({
    layout: () => {
        place(tree.root, tree.root.old, 0);
        return cellsOf(tree.root, order);
    },
    correct: (drawn, rate) => correct(tree.root, drawn, rate),
    minimum: (drawn, min) => belowMinimum(tree.root, drawn, min),
});
/** ADD: the plan of adding `card` beside `target` toward `side`. */
export function insertCard(cells, boxes, drawn, target, side, card, gap) {
    if (!SIDES.includes(side))
        throw new Error(`unknown side ${String(side)}; use left, right, top or bottom`);
    const taken = ids(cells, boxes);
    const arriving = 'cards' in card ? [card.id, ...card.cards.map((c) => c.card.id)] : [card.id];
    const member = arriving.find((id) => taken.has(id));
    if (member !== undefined)
        throw new Error(`card ${member} is a member of the layout`);
    const tree = { root: planeTree(cells, boxes, drawn, across(axisOf(side))) };
    addBeside(tree, targetNode(tree, target), side, arrivingNode(card), gap);
    return planOf(tree, cells.cards.map((c) => c.id));
}
/** REMOVE: the plan of taking the member `id` out of its cut, and what left. `prefer` is the outer cut first. */
export function withdrawMember(cells, boxes, drawn, id, prefer) {
    var _a;
    const tree = { root: planeTree(cells, boxes, drawn, prefer) };
    const found = find(tree.root, id);
    if (!found)
        throw new Error(`card ${id} is not a member of the layout`);
    const { node, cut: holder } = found;
    if (node.kind === 'leaf' && ((_a = node.card) === null || _a === void 0 ? void 0 : _a.fixed))
        throw new Error(`card ${id} is fixed and does not leave`);
    const standing = cardsOf(node, false);
    const gone = new Set(standing.map((c) => c.card.id));
    if (!holder || cells.cards.every((card) => card.fixed || gone.has(card.id)))
        throw new Error(`card ${id} is the last card of the layout`);
    const axis = holder.axis;
    const rest = holder.kids.filter((kid) => kid !== node);
    if (rest.every((kid) => isHeld(kid, axis)))
        throw new Error(`card ${id} leaves no card of its cut that takes its space`);
    const left = {
        id,
        box: node.kind === 'leaf' ? node.box : null,
        above: node.above,
        cards: standing.map(({ card, at }) => ({ card, ...at, rect: drawn.get(card.id) })),
    };
    rest.forEach((kid) => {
        if (!isHeld(kid, axis))
            kid.weight = weightOf(kid, axis);
    });
    // A cut left with one child lays it across its whole rectangle.
    holder.kids = rest;
    holder.adjust = rest.map(() => 0);
    holder.dirty = true;
    return { plan: planOf(tree, cells.cards.filter((c) => !gone.has(c.id)).map((c) => c.id)), left };
}
/** Even: the plan of giving every child of every cut an equal share. */
export function evenCuts(cells, boxes, drawn) {
    const tree = { root: planeTree(cells, boxes, drawn, ['x', 'y']) };
    const mark = (node) => {
        if (node.kind === 'leaf') {
            if (node.inner)
                mark(node.inner);
            return;
        }
        node.dirty = true;
        node.kids.forEach((kid) => {
            kid.weight = 1;
            mark(kid);
        });
    };
    mark(tree.root);
    return planOf(tree, cells.cards.map((c) => c.id));
}
