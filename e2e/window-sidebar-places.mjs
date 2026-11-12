// The measures of the window check of the four sides (docs/spec/external-sidebars.md#verification): where the order places the
// window sidebars of a grid and what core.sidebars reports of them.

/** The sides of a window. */
export const SIDES = Object.freeze(["left", "right", "top", "bottom"]);

/** The axis of the thickness of the sidebar of a side. */
const AXIS = { left: "x", right: "x", top: "y", bottom: "y" };
/** The two sides of each axis: the side at line 0 and the side at the last line. */
const ENDS = { x: ["left", "right"], y: ["top", "bottom"] };
/** The orientation of the sections of the sidebar of a side. */
const ORIENTATION = { left: "vertical", right: "vertical", top: "horizontal", bottom: "horizontal" };

/** Every order of the sides, each side once. */
export function orders(sides = SIDES) {
  if (sides.length <= 1) return [[...sides]];
  return sides.flatMap((side) => orders(sides.filter((other) => other !== side)).map((rest) => [side, ...rest]));
}

/** The start, the size and the extent of a card on an axis. */
const span = (card, axis) => (axis === "x" ? [card.x, card.w, card.y, card.h] : [card.y, card.h, card.x, card.w]);

/** The thickness of each window sidebar of the grid on its axis. */
export function thicknesses(grid) {
  return Object.fromEntries(SIDES.flatMap((side) => {
    const card = grid.cards.find((item) => item.id === side);
    return card ? [[side, span(card, AXIS[side])[1]]] : [];
  }));
}

/**
 * The mismatches of the window sidebars of the grid against the order, one text each, empty when every sidebar stands where the
 * order places it: each side of `held` has one sidebar and no other side has one; the sidebar stands at the border of the plane
 * on its side, has the thickness of `thickness` on its axis when that names the side, and reaches along the other axis from the
 * border, or from the gap after the inner line of the sidebar of an earlier side of that axis, to the opposite border, or to the
 * gap before such a sidebar. Positions are compared within 1 point; a gap holds from 1 point less than nothing to 1 point more
 * than the gap of the grid.
 */
export function placeMismatches(grid, order, held, thickness = {}) {
  const found = [];
  const cards = Object.fromEntries(SIDES.map((side) => [side, grid.cards.find((item) => item.id === side)]));
  for (const side of SIDES) {
    if (held.includes(side) && !cards[side]) found.push(`${side} is missing`);
    if (!held.includes(side) && cards[side]) found.push(`${side} stands although its side holds no sidebar`);
  }
  const near = (a, b) => Math.abs(a - b) <= 1;
  const gapped = (inner, outer) => outer - inner >= -1 && outer - inner <= grid.gap + 1;
  const arranged = order.filter((side) => held.includes(side) && cards[side]);
  arranged.forEach((side, index) => {
    const axis = AXIS[side];
    const other = axis === "x" ? "y" : "x";
    const [start, size, from, extent] = span(cards[side], axis);
    const length = axis === "x" ? grid.width : grid.height;
    const reach = other === "x" ? grid.width : grid.height;
    const border = side === ENDS[axis][0] ? 0 : length - size;
    if (!near(start, border)) found.push(`${side} stands at ${start} on ${axis}, not at its border ${border}`);
    if (thickness[side] !== undefined && !near(size, thickness[side])) found.push(`${side} is ${size} thick on ${axis}, expected ${thickness[side]}`);
    const earlier = arranged.slice(0, index);
    const [low, high] = ENDS[other].map((end) => (earlier.includes(end) ? cards[end] : null));
    if (low === null ? !near(from, 0) : !gapped(span(low, other)[0] + span(low, other)[1], from))
      found.push(`${side} starts at ${from} on ${other}, expected ${low === null ? 0 : `after ${span(low, other)[0] + span(low, other)[1]}`}`);
    const end = from + extent;
    if (high === null ? !near(end, reach) : !gapped(end, span(high, other)[0]))
      found.push(`${side} ends at ${end} on ${other}, expected ${high === null ? reach : `before ${span(high, other)[0]}`}`);
  });
  return found;
}

/** The mismatches of the window sidebar reports of core.sidebars against the sides of `held` that the grid holds. */
export function reportMismatches(bars, grid, held) {
  const found = [];
  const windows = bars.filter((bar) => bar.placement === "window");
  for (const side of held) {
    const reported = windows.filter((bar) => bar.sidebar === side);
    if (reported.length !== 1) {
      found.push(`core.sidebars reports ${reported.length} window sidebars of ${side}, expected 1`);
      continue;
    }
    const [bar] = reported;
    if (bar.orientation !== ORIENTATION[side]) found.push(`${side} reports the orientation ${bar.orientation}, expected ${ORIENTATION[side]}`);
    const card = grid.cards.find((item) => item.id === side);
    if (!card) continue;
    const x = grid.plane.x + card.x, y = grid.plane.y + card.y;
    const { rect } = bar;
    if (!(rect.w > 0 && rect.h > 0 && rect.x >= x - 1 && rect.y >= y - 1 && rect.x + rect.w <= x + card.w + 1 && rect.y + rect.h <= y + card.h + 1))
      found.push(`${side} reports the rect ${JSON.stringify(rect)} outside its card at x ${x}, y ${y}, w ${card.w}, h ${card.h}`);
  }
  for (const bar of windows) if (!held.includes(bar.sidebar)) found.push(`core.sidebars reports a window sidebar of ${bar.sidebar}, whose side holds none`);
  return found;
}
