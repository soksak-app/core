// The tree of the content cards of a layout that the window description reports (docs/spec/exposure.md#window-snapshot,
// docs/spec/cli.md#acting-on-a-layout), read from the stored tree of the layout; the workbench of the mygo host reads the same tree by
// the cases of docs/spec/cases/layout/tree.json.
import { isPlace } from "./registry.js";

/**
 * The tree of a node of the stored tree: a split is {direction, size, frame, children} and a card is the value that leaf(id, size)
 * returns, with its frame {x, y, width, height}. A cut along x is a row and a cut along y a column; a box is a leaf by its id when
 * boxed and else the node inside it, and a window sidebar is a place card and is outside the tree, so a cut that holds one gives its
 * share to its other kids in proportion and a cut left with one kid is that kid. size is the share of a node among the kids of its split
 * that the tree holds, and 1 for the root. The frame of a split is the smallest rectangle that holds the frames of its children. A node
 * without a content card or a box has no tree, null.
 */
export function layoutTree(node, boxed, leaf) {
  const of = (at, size) => {
    if (at.box !== undefined) return boxed ? leaf(at.box, size) : of(at.inner, size);
    if (at.cut === undefined) return isPlace(at.card) ? null : leaf(at.card, size);
    const kept = at.kids.filter((kid) => holds(kid.node, boxed));
    if (kept.length === 0) return null;
    if (kept.length === 1) return of(kept[0].node, size);
    const total = kept.reduce((sum, kid) => sum + kid.share, 0);
    const children = kept.map((kid) => of(kid.node, kid.share / total));
    return { direction: at.cut === "x" ? "row" : "column", size, frame: frameAround(children.map((child) => child.frame)), children };
  };
  return holds(node, boxed) ? of(node, 1) : null;
}

/** Whether a node holds a node of the tree: a content card, or a box when boxed. */
function holds(node, boxed) {
  if (node.box !== undefined) return boxed || holds(node.inner, boxed);
  if (node.cut === undefined) return !isPlace(node.card);
  return node.kids.some((kid) => holds(kid.node, boxed));
}

/** The smallest rectangle {x, y, width, height} that holds the frames. */
function frameAround(frames) {
  const x = Math.min(...frames.map((frame) => frame.x));
  const y = Math.min(...frames.map((frame) => frame.y));
  return { x, y, width: Math.max(...frames.map((frame) => frame.x + frame.width)) - x,
    height: Math.max(...frames.map((frame) => frame.y + frame.height)) - y };
}

/**
 * The cards of a stored tree state in tree order, each {id, data?, fixed?, width?, height?} as the cards of a grid name them, so a reader of
 * the cards of a stored layout and of a grid reads one form.
 */
export function stateCards(state) {
  const out = [];
  const walk = (node) => {
    if (node.box !== undefined) walk(node.inner);
    else if (node.cut !== undefined) for (const kid of node.kids) walk(kid.node);
    else {
      const { card, ...rest } = node;
      out.push({ id: card, ...rest });
    }
  };
  walk(state.root);
  return out;
}

/** The state with each card node replaced by what change returns for it; the cuts and the boxes stay. */
export function mapStateCards(state, change) {
  const map = (node) => {
    if (node.box !== undefined) return { ...node, inner: map(node.inner) };
    if (node.cut !== undefined) return { ...node, kids: node.kids.map((kid) => ({ ...kid, node: map(kid.node) })) };
    return change(node);
  };
  return { ...state, root: map(state.root) };
}

/**
 * Whether two JSON values are equal as JSON values: the order of the members of an object makes no difference, and numbers compare by
 * their value, so 1 and 1.0 are one number.
 */
export function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}
