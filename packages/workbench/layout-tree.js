// The tree of the content cards of a layout and the reading of its lines that the layout operations use
// (docs/spec/exposure.md#window-snapshot, docs/spec/cli.md#acting-on-a-layout). The layout stores lines and cards and no split, so the
// splits are derived from the lines at each reading; the workbench of the mygo host derives the same tree by the cases of
// docs/spec/cases/layout/tree.json.
import { sliceTree } from "soksak";

const SPAN = { x: ["c0", "c1"], y: ["r0", "r1"] };

/**
 * The tree of cards over the line positions xs and ys: a split is {direction, size, frame, children} and a card is the value that
 * leaf(card, size) returns, with its frame {x, y, width, height}. The frame of a split is the smallest rectangle that holds the frames
 * of its children, so an agent reads the extent of each row and column in window points. A region is a row when a vertical line crosses it from edge to edge (sliceTree tries the x axis
 * first), and size is the share of a node in the extent of its parent along the direction of the parent, 1 for the root.
 * Cards that are not slicing have no tree, which no layout of the plane holds, so it is an error.
 */
export function layoutTree(cards, xs, ys, leaf) {
  if (cards.length === 0) throw new Error("the layout holds no content card");
  const slice = sliceTree(cards);
  if (!slice) throw new Error("the content cards of the layout are not a slicing arrangement");
  const lines = { x: xs, y: ys };
  const extent = (node, axis) => {
    const [lo, hi] = SPAN[axis];
    const of = "card" in node ? [node.card] : cardsOf(node);
    return [Math.min(...of.map((card) => card[lo])), Math.max(...of.map((card) => card[hi]))];
  };
  const build = (node, size) => {
    if ("card" in node) return leaf(node.card, size);
    const axis = node.axis;
    const [start, end] = extent(node, axis);
    const whole = lines[axis][end] - lines[axis][start];
    const children = node.sides.map((side) => {
      const [from, to] = extent(side, axis);
      return build(side, (lines[axis][to] - lines[axis][from]) / whole);
    });
    return { direction: axis === "x" ? "row" : "column", size, frame: frameAround(children.map((child) => child.frame)), children };
  };
  return build(slice, 1);
}

/** The smallest rectangle {x, y, width, height} that holds the frames. */
function frameAround(frames) {
  const x = Math.min(...frames.map((frame) => frame.x));
  const y = Math.min(...frames.map((frame) => frame.y));
  return { x, y, width: Math.max(...frames.map((frame) => frame.x + frame.width)) - x,
    height: Math.max(...frames.map((frame) => frame.y + frame.height)) - y };
}

/** The cards under a slice. */
function cardsOf(node) {
  return "card" in node ? [node.card] : node.sides.flatMap(cardsOf);
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
