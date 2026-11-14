// The tree of the content cards of a layout and the reading of its lines that the layout operations use
// (docs/spec/exposure.md#window-snapshot, docs/spec/cli.md#acting-on-a-layout). The layout stores lines and cards and no split, so the
// splits are derived from the lines at each reading; the workbench of the mygo host derives the same tree by the cases of
// docs/spec/cases/layout/tree.json.
import { sliceTree } from "soksak";

const SPAN = { x: ["c0", "c1"], y: ["r0", "r1"] };

/**
 * The tree of cards over the line positions xs and ys: a split is {direction, size, children} and a card is the value that
 * leaf(card, size) returns. A region is a row when a vertical line crosses it from edge to edge (sliceTree tries the x axis
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
    return {
      direction: axis === "x" ? "row" : "column",
      size,
      children: node.sides.map((side) => {
        const [from, to] = extent(side, axis);
        return build(side, (lines[axis][to] - lines[axis][from]) / whole);
      }),
    };
  };
  return build(slice, 1);
}

/** The cards under a slice. */
function cardsOf(node) {
  return "card" in node ? [node.card] : node.sides.flatMap(cardsOf);
}

/**
 * The neighbour of card toward side among cards: the card whose edge lies on the line of the edge of card on that side and whose
 * extent across that side spans the same two lines as card, compared by the lines of the layout, or null.
 */
export function neighbourToward(cards, card, side) {
  const near = {
    left: (other) => other.c1 === card.c0 && other.r0 === card.r0 && other.r1 === card.r1,
    right: (other) => other.c0 === card.c1 && other.r0 === card.r0 && other.r1 === card.r1,
    top: (other) => other.r1 === card.r0 && other.c0 === card.c0 && other.c1 === card.c1,
    bottom: (other) => other.r0 === card.r1 && other.c0 === card.c0 && other.c1 === card.c1,
  }[side];
  if (!near) throw new Error(`unknown side ${side}; use left, right, top or bottom`);
  return cards.find((other) => other.id !== card.id && near(other)) ?? null;
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
