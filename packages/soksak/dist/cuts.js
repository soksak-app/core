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
import { cardsOf as storedCards, cloneNode, isBox, isCut } from './tree.js';
const SIDES = ['left', 'right', 'top', 'bottom'];
const ENDS = { x: ['x0', 'x1'], y: ['y0', 'y1'] };
const NONE = { x0: 0, x1: 0, y0: 0, y1: 0 };
const union = (extents) => ({
    x0: Math.min(...extents.map((e) => e.x0)),
    x1: Math.max(...extents.map((e) => e.x1)),
    y0: Math.min(...extents.map((e) => e.y0)),
    y1: Math.max(...extents.map((e) => e.y1)),
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
    return {
        kind: 'cut', axis, kids, old, rect: old, above: kids[0].above, placedAbove: 0, weight: null, dirty, shares: null, laid: false,
        adjust: kids.map(() => 0),
    };
}
function cardLeaf(card, old, spans) {
    return {
        kind: 'leaf', id: card.card, card, box: null, head: 0, inner: null,
        held: { x: holds(card, spans, 'x'), y: holds(card, spans, 'y') }, old, rect: old, above: 0, placedAbove: 0, weight: null,
    };
}
function boxLeaf(box, head, inner, old) {
    return {
        kind: 'leaf', id: box.box, card: null, box, head, inner, held: { x: false, y: false }, old, rect: old, above: 0, placedAbove: 0,
        weight: null,
    };
}
/** Sets the px of the heads above each node where it stands: the kids of a cut along x share it, a cut along y gives it to its first kid. */
function assignAbove(node, above) {
    node.above = above;
    if (node.kind === 'leaf') {
        if (node.inner)
            assignAbove(node.inner, above + node.head);
        return;
    }
    node.kids.forEach((kid, i) => assignAbove(kid, node.axis === 'x' || i === 0 ? above : 0));
}
/** The tree of an operation with an index of its nodes: the leaf of each id, and the cut and the box leaf that hold each node. */
class Tree {
    constructor(root, input) {
        this.input = input;
        this.byId = new Map();
        this.parent = new Map();
        this.owner = new Map();
        this.root = root;
        this.enter(root, null, null);
    }
    /** Adds `node` and the nodes below it to the index, held by the cut `parent` inside the box leaf `owner`. */
    enter(node, parent, owner) {
        this.input.visit();
        if (parent)
            this.parent.set(node, parent);
        else
            this.parent.delete(node);
        if (owner)
            this.owner.set(node, owner);
        else
            this.owner.delete(node);
        if (node.kind === 'leaf') {
            this.byId.set(node.id, node);
            if (node.inner)
                this.enter(node.inner, null, node);
            return;
        }
        for (const kid of node.kids)
            this.enter(kid, node, owner);
    }
    /** Puts `next` where `node` stood: in its cut, inside its box leaf, or as the root. */
    replace(node, next) {
        const holder = this.parent.get(node);
        const owner = this.owner.get(node);
        if (holder)
            holder.kids[holder.kids.indexOf(node)] = next;
        else if (owner)
            owner.inner = next;
        else
            this.root = next;
        this.enter(next, holder !== null && holder !== void 0 ? holder : null, owner !== null && owner !== void 0 ? owner : null);
    }
}
/** The tree of an operation read from the stored tree, with each leaf where it stands and each box with its head. */
function treeOf(input) {
    const convert = (node) => {
        var _a;
        input.visit();
        const old = input.extent(node);
        if (isCut(node)) {
            const out = cut(node.cut, node.kids.map((kid) => convert(kid.node)), false);
            out.old = old;
            out.rect = old;
            return out;
        }
        if (isBox(node))
            return boxLeaf(node, (_a = input.heads.get(node.box)) !== null && _a !== void 0 ? _a : 0, convert(node.inner), old);
        const card = input.card(node.card);
        return cardLeaf(node, old, { x: card.c1 - card.c0, y: card.r1 - card.r0 });
    };
    const tree = new Tree(convert(input.root), input);
    assignAbove(tree.root, 0);
    return tree;
}
/** The ids of the leaves of a node in its own tree, without the members inside its boxes. */
function members(node) {
    return node.kind === 'leaf' ? [node.id] : node.kids.flatMap(members);
}
/** The drawn extent of every node of the tree in px, from the drawn rectangles of its cards, computed once for an operation. */
function drawnOf(root, drawn, input) {
    const out = new Map();
    const visit = (node) => {
        input.visit();
        let at;
        if (node.kind === 'cut')
            at = union(node.kids.map(visit));
        else if (node.inner)
            at = visit(node.inner);
        else {
            const r = drawn.get(node.id);
            at = { x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h };
        }
        out.set(node, at);
        return at;
    };
    visit(root);
    return out;
}
const extentOn = (e, axis) => (axis === 'x' ? e.x1 - e.x0 : e.y1 - e.y0);
/** The size of a node among the kids of a cut along `axis`: its drawn extent, less on y the heads above it. */
const sizeAlong = (node, axis, sizes) => { var _a; return extentOn((_a = sizes.get(node)) !== null && _a !== void 0 ? _a : NONE, axis) - (axis === 'y' ? node.above : 0); };
const isHeld = (node, axis) => node.kind === 'leaf' && node.held[axis];
const weightOf = (node, axis, sizes) => { var _a; return (_a = node.weight) !== null && _a !== void 0 ? _a : sizeAlong(node, axis, sizes); };
/**
 * Lays a node into its rectangle: the kids of a cut that changed or whose rectangle moved on its axis by their weights, and the kids of
 * a cut that arrives with its node by the shares it keeps.
 */
function place(node, rect, above, sizes, input) {
    input.visit();
    node.rect = rect;
    node.placedAbove = above;
    if (node.kind === 'leaf') {
        if (node.inner)
            place(node.inner, rect, above + node.head, sizes, input);
        return;
    }
    const axis = node.axis;
    const [lo, hi] = ENDS[axis];
    const kept = !node.dirty && !node.shares && rect[lo] === node.old[lo] && rect[hi] === node.old[hi] && above === node.above;
    node.laid = !kept && !node.shares;
    const spans = node.kids.map((kid) => kid.old[hi] - kid.old[lo]);
    if (node.shares) {
        const shares = node.shares;
        node.kids.forEach((_, i) => {
            spans[i] = (rect[hi] - rect[lo]) * shares[i];
        });
    }
    else if (!kept) {
        let free = rect[hi] - rect[lo];
        node.kids.forEach((kid, i) => {
            if (isHeld(kid, axis))
                free -= spans[i];
        });
        const sharing = node.kids.filter((kid) => !isHeld(kid, axis));
        const total = sharing.reduce((a, kid) => a + weightOf(kid, axis, sizes), 0);
        node.kids.forEach((kid, i) => {
            if (isHeld(kid, axis))
                return;
            const share = total > 0 ? weightOf(kid, axis, sizes) / total : 1 / sharing.length;
            spans[i] = Math.max(0, Math.max(0, free) * share + node.adjust[i]);
        });
    }
    let at = rect[lo];
    node.kids.forEach((kid, i) => {
        const last = i === node.kids.length - 1;
        const from = kept ? kid.old[lo] : at;
        const end = kept ? kid.old[hi] : last ? rect[hi] : at + spans[i];
        place(kid, { ...rect, [lo]: from, [hi]: end }, axis === 'x' || i === 0 ? above : 0, sizes, input);
        at = end;
    });
}
/**
 * The stored node of a laid node: a cut takes the shares of the rectangles that its kids were laid at, a kid cut along the axis of its
 * cut gives that cut its kids, and a cut of one kid is that kid, so the tree stays canonical.
 */
function storedOf(node) {
    if (node.kind === 'leaf') {
        if (node.inner) {
            const box = node.box;
            return { box: box.box, ...(box.data !== undefined ? { data: box.data } : {}), inner: storedOf(node.inner) };
        }
        return cloneNode(node.card);
    }
    const [lo, hi] = ENDS[node.axis];
    const total = node.rect[hi] - node.rect[lo];
    const kids = [];
    for (const kid of node.kids) {
        const share = total > 0 ? (kid.rect[hi] - kid.rect[lo]) / total : 1 / node.kids.length;
        const stored = storedOf(kid);
        if (isCut(stored) && stored.cut === node.axis)
            for (const k of stored.kids)
                kids.push({ share: share * k.share, node: k.node });
        else
            kids.push({ share, node: stored });
    }
    return kids.length === 1 ? kids[0].node : { cut: node.axis, kids };
}
/** Moves each span that the last layout laid by the difference between its drawn size and the size its weight asks for. */
function correct(root, drawn, rate, sizes, input) {
    const now = drawnOf(root, drawn, input);
    let worst = 0;
    const visit = (node) => {
        input.visit();
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
        const sharing = node.kids.map((_, i) => i).filter((i) => !isHeld(node.kids[i], axis));
        const drawnSizes = node.kids.map((kid) => extentOn(now.get(kid), axis) - (axis === 'y' ? kid.placedAbove : 0));
        const total = sharing.reduce((a, i) => a + weightOf(node.kids[i], axis, sizes), 0);
        const room = sharing.reduce((a, i) => a + drawnSizes[i], 0);
        for (const i of sharing) {
            const want = total > 0 ? (room * weightOf(node.kids[i], axis, sizes)) / total : room / sharing.length;
            const error = drawnSizes[i] - want;
            worst = Math.max(worst, Math.abs(error));
            node.adjust[i] -= error / each;
        }
    };
    visit(root);
    return worst;
}
/** The node of what arrives: a new card, or a card or a box that left, whose cuts keep their shares where it lands. */
function arriving(node) {
    if (isCut(node)) {
        const kids = node.kids.map((kid) => arriving(kid.node));
        const out = cut(node.cut, kids, true);
        out.shares = node.kids.map((kid) => kid.share);
        return out;
    }
    if (isBox(node))
        return boxLeaf(node, 0, arriving(node.inner), NONE);
    return cardLeaf(cloneNode(node), NONE, { x: 1, y: 1 });
}
/**
 * The target of an insert toward an axis: the node of one member, or the neighbouring kids of one cut that hold exactly the
 * members. A run of kids is the target itself when the insert goes along its cut, so the node joins that cut; across it, the run
 * becomes a cut of its own that the insert wraps.
 */
function targetNode(tree, target, sizes, axis) {
    var _a;
    const list = typeof target === 'string' ? [target] : [...target];
    const hits = list.map((id) => {
        const hit = tree.byId.get(id);
        if (!hit)
            throw new Error(`card ${id} is not a member of the layout`);
        return hit;
    });
    if (list.length === 1)
        return hits[0];
    const refused = () => new Error(`cards ${list.join(', ')} are not neighbours of one cut`);
    const wanted = new Set(list);
    // The cut that holds every listed node is the lowest cut above the first whose leaves count all of them.
    let level = null;
    for (let at = tree.parent.get(hits[0]); at; at = tree.parent.get(at)) {
        if (members(at).filter((id) => wanted.has(id)).length === wanted.size) {
            level = at;
            break;
        }
    }
    if (!level)
        throw refused();
    const holder = level;
    const touched = holder.kids.map((kid, i) => (members(kid).some((id) => wanted.has(id)) ? i : -1)).filter((i) => i >= 0);
    const first = touched[0];
    const last = touched[touched.length - 1];
    const span = holder.kids.slice(first, last + 1);
    const held = span.flatMap(members);
    if (held.length !== wanted.size || !held.every((id) => wanted.has(id)))
        throw refused();
    if (first === 0 && last === holder.kids.length - 1)
        return holder;
    if (holder.axis === axis)
        return { holder, first, last };
    const sub = cut(holder.axis, span, false);
    sub.weight = span.reduce((a, k) => a + weightOf(k, holder.axis, sizes), 0);
    sizes.set(sub, union(span.map((k) => sizes.get(k))));
    holder.kids.splice(first, span.length, sub);
    holder.adjust = holder.kids.map(() => 0);
    tree.enter(sub, holder, (_a = tree.owner.get(holder)) !== null && _a !== void 0 ? _a : null);
    return sub;
}
/** The difference in px under which the sizes of the kids of a cut are equal, so the cut is even. */
const EVEN = 0.5;
/** Whether the kids of a cut that keep no span on its axis have one size. */
function isEven(into, sizes) {
    const all = into.kids.filter((kid) => !isHeld(kid, into.axis)).map((kid) => weightOf(kid, into.axis, sizes));
    return all.every((size) => Math.abs(size - all[0]) < EVEN);
}
/**
 * Adds the node `arriving` beside `node` toward `side`. Along the cut of the target, an even cut gives it 1/(k+1) and keeps every ratio;
 * a cut that is not even takes half of the target less the new corridor, `gap`, the kid toward `side` when the target is the cut itself,
 * and keeps every other size. Across the cut, the target is wrapped in a new cut of two halves.
 */
function addBeside(tree, target, side, coming, gap, sizes) {
    var _a;
    const axis = axisOf(side);
    const after = side === 'right' || side === 'bottom';
    const insertInto = (into, at, payers) => {
        var _a;
        const sharing = into.kids.filter((kid) => !isHeld(kid, axis));
        const even = isEven(into, sizes);
        sharing.forEach((kid) => {
            kid.weight = weightOf(kid, axis, sizes);
        });
        const paying = payers.filter((kid) => !isHeld(kid, axis));
        if (even || !paying.length) {
            const total = sharing.reduce((a, kid) => a + kid.weight, 0);
            coming.weight = sharing.length ? total / sharing.length : 1;
        }
        else {
            // The target gives half of its size, the new corridor included, so every other kid keeps its drawn size; the kids of a run
            // give it in proportion and keep their ratios.
            const sum = paying.reduce((a, kid) => a + kid.weight, 0);
            const half = Math.max(0, sum - gap) / 2;
            for (const kid of paying)
                kid.weight = sum > 0 ? (kid.weight * half) / sum : 0;
            coming.weight = half;
        }
        into.kids.splice(at, 0, coming);
        into.adjust = into.kids.map(() => 0);
        into.dirty = true;
        tree.enter(coming, into, (_a = tree.owner.get(into)) !== null && _a !== void 0 ? _a : null);
    };
    if ('holder' in target) {
        insertInto(target.holder, after ? target.last + 1 : target.first, target.holder.kids.slice(target.first, target.last + 1));
        return;
    }
    const node = target;
    const holder = (_a = tree.parent.get(node)) !== null && _a !== void 0 ? _a : null;
    if (node.kind === 'cut' && node.axis === axis) {
        insertInto(node, after ? node.kids.length : 0, [after ? node.kids[node.kids.length - 1] : node.kids[0]]);
        return;
    }
    if (holder && holder.axis === axis) {
        insertInto(holder, holder.kids.indexOf(node) + (after ? 1 : 0), [node]);
        return;
    }
    const weight = holder ? weightOf(node, holder.axis, sizes) : null;
    const next = cut(axis, after ? [node, coming] : [coming, node], true);
    next.old = node.old;
    next.rect = node.old;
    next.above = node.above;
    next.weight = weight;
    sizes.set(next, sizes.get(node));
    node.weight = 1;
    coming.weight = 1;
    tree.replace(node, next);
}
/**
 * The size that a node needs on an axis, in the px of the grid rectangles: a card its minimum and on y the heads drawn inside its
 * rectangle; a box the need of its inner node; a cut along the axis the needs of its kids and the corridors between them; a cut across
 * it the largest need of its kids. A kid that keeps its span needs the size it is drawn at.
 */
function need(node, axis, now, min) {
    const extent = (n) => extentOn(now.get(n), axis);
    if (node.kind === 'leaf') {
        if (node.inner)
            return need(node.inner, axis, now, min);
        if (node.held[axis])
            return extent(node);
        return min + (axis === 'y' ? node.placedAbove : 0);
    }
    const kids = node.kids.map((kid) => need(kid, axis, now, min));
    if (node.axis !== axis)
        return Math.max(...kids);
    const corridors = extent(node) - node.kids.reduce((a, kid) => a + extent(kid), 0);
    return kids.reduce((a, n) => a + n, 0) + corridors;
}
/** The text of the outermost node whose rectangle the plan changed and that is drawn below its minimum, or null. */
function belowMinimum(root, drawn, min, input) {
    const now = drawnOf(root, drawn, input);
    const text = (n) => String(Math.round(n));
    const visit = (node) => {
        input.visit();
        const moved = ['x0', 'x1', 'y0', 'y1'].some((key) => Math.abs(node.rect[key] - node.old[key]) > 1e-9);
        if (node.kind === 'leaf' && moved) {
            const has = now.get(node);
            const w = has.x1 - has.x0;
            const h = has.y1 - has.y0;
            const needs = { x: need(node, 'x', now, min), y: need(node, 'y', now, min) };
            if (w < needs.x - EVEN || h < needs.y - EVEN) {
                return `card ${node.id} would be ${text(w)}x${text(h)}, below its minimum ${text(needs.x)}x${text(needs.y)}`;
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
function planOf(tree, sizes, input) {
    return {
        layout: () => {
            place(tree.root, tree.root.old, 0, sizes, input);
            return storedOf(tree.root);
        },
        correct: (drawn, rate) => correct(tree.root, drawn, rate, sizes, input),
        minimum: (drawn, min) => belowMinimum(tree.root, drawn, min, input),
    };
}
/** The tree of an operation and the drawn size of each of its nodes before it. */
function start(input) {
    const tree = treeOf(input);
    return { tree, sizes: drawnOf(tree.root, input.drawn, input) };
}
/** ADD: the plan of adding `node`, a new card or what `withdraw` returned, beside `target` toward `side`. */
export function insertNode(input, target, side, node, gap) {
    if (!SIDES.includes(side))
        throw new Error(`unknown side ${String(side)}; use left, right, top or bottom`);
    const ids = [isBox(node) ? node.box : isCut(node) ? null : node.card, ...storedCards(node).map((c) => c.card)];
    const member = ids.find((id) => id !== null && input.taken(id));
    if (member !== undefined && member !== null)
        throw new Error(`card ${member} is a member of the layout`);
    const { tree, sizes } = start(input);
    addBeside(tree, targetNode(tree, target, sizes, axisOf(side)), side, arriving(node), gap, sizes);
    return planOf(tree, sizes, input);
}
/** REMOVE: the plan of taking the card or the box `id` out of its cut, and the stored node that left. */
export function withdrawNode(input, id, cards) {
    var _a;
    var _b;
    const { tree, sizes } = start(input);
    const node = tree.byId.get(id);
    if (!node)
        throw new Error(`card ${id} is not a member of the layout`);
    if ((_a = node.card) === null || _a === void 0 ? void 0 : _a.fixed)
        throw new Error(`card ${id} is fixed and does not leave`);
    const holder = tree.parent.get(node);
    const gone = new Set(node.box ? storedCards(node.box).map((c) => c.card) : [id]);
    if (!holder || cards.every((card) => card.fixed || gone.has(card.id)))
        throw new Error(`card ${id} is the last card of the layout`);
    const axis = holder.axis;
    const rest = holder.kids.filter((kid) => kid !== node);
    if (rest.every((kid) => isHeld(kid, axis)))
        throw new Error(`card ${id} leaves no card of its cut that takes its space`);
    const left = cloneNode((_b = node.box) !== null && _b !== void 0 ? _b : node.card);
    rest.forEach((kid) => {
        if (!isHeld(kid, axis))
            kid.weight = weightOf(kid, axis, sizes);
    });
    // A cut left with one kid lays it across its whole rectangle, and storedOf gives the cut of one kid as that kid.
    holder.kids = rest;
    holder.adjust = rest.map(() => 0);
    holder.dirty = true;
    return { plan: planOf(tree, sizes, input), left };
}
/** Even: the plan of giving every kid of every cut an equal share. */
export function evenCuts(input) {
    const { tree, sizes } = start(input);
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
    return planOf(tree, sizes, input);
}
