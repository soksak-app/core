import assert from "node:assert/strict";
import test from "node:test";
import { windowSidebarsPlaced } from "../verify-checks.js";

const ORDER = ["left", "right", "top", "bottom"];

/** A plane of three columns and three rows whose cards are cards, with the drawn size drawn ({w, h} by id, 190 by default). */
function grid(cards, drawn = {}) {
  return {
    cards,
    card: (id) => cards.find((card) => card.id === id),
    rect: (id) => ({ w: drawn[id]?.w ?? 190, h: drawn[id]?.h ?? 190 }),
    lines: () => [0, 1, 2, 3],
  };
}
const card = (id, c0, c1, r0, r1, extra = {}) => ({ id, c0, c1, r0, r1, fixed: true,
  ...(id === "left" || id === "right" ? { width: 190 } : { height: 190 }), ...extra });

test("placement verification accepts one full-height sidebar at each window edge", () => {
  assert.equal(windowSidebarsPlaced(grid([card("left", 0, 1, 0, 3), card("right", 2, 3, 0, 3)]), ORDER), true);
});

test("placement verification checks every window sidebar's requested extent", () => {
  assert.equal(windowSidebarsPlaced(grid([card("left", 0, 1, 0, 3)], { left: { w: 210 } }), ORDER), false, "a sidebar wider than its saved width was accepted");
  assert.equal(windowSidebarsPlaced(grid([card("left", 1, 2, 0, 3)]), ORDER), false, "a left sidebar away from the window edge was accepted");
  assert.equal(windowSidebarsPlaced(grid([card("left", 0, 1, 0, 2)]), ORDER), false, "a sidebar shorter than the window was accepted");
  assert.equal(windowSidebarsPlaced(grid([card("left", 0, 1, 0, 3, { fixed: false })]), ORDER), false, "a sidebar that is not fixed was accepted");
});

// An edge holds one window sidebar (docs/spec/external-sidebars.md#verification): a second card of an edge beside one that stands in its
// place is refused.
test("placement verification refuses two sidebars of one edge", () => {
  const two = {
    left: [card("left", 0, 1, 0, 3), card("left", 1, 2, 0, 3)],
    right: [card("right", 2, 3, 0, 3), card("right", 1, 2, 0, 3)],
    top: [card("top", 0, 3, 0, 1), card("top", 0, 3, 1, 2)],
    bottom: [card("bottom", 0, 3, 2, 3), card("bottom", 0, 3, 1, 2)],
  };
  for (const [edge, cards] of Object.entries(two)) {
    assert.equal(windowSidebarsPlaced(grid(cards.slice(0, 1)), ORDER), true, `one ${edge} sidebar in its place was refused`);
    assert.equal(windowSidebarsPlaced(grid(cards), ORDER), false, `two ${edge} sidebars were accepted`);
  }
});

// The expected place of each sidebar comes from the order (docs/spec/external-sidebars.md#verification).
test("placement verification computes the place of the top and bottom sidebars from the order", () => {
  const between = [card("left", 0, 1, 0, 3), card("right", 2, 3, 0, 3), card("top", 1, 2, 0, 1), card("bottom", 1, 2, 2, 3)];
  assert.equal(windowSidebarsPlaced(grid(between), ORDER), true, "top and bottom between the left and right sidebars");
  assert.equal(windowSidebarsPlaced(grid(between), ["top", "left", "right", "bottom"]), false, "a top sidebar that does not span the width was accepted with top first");
  const across = [card("top", 0, 3, 0, 1), card("left", 0, 1, 1, 3), card("right", 2, 3, 1, 3), card("bottom", 1, 2, 2, 3)];
  assert.equal(windowSidebarsPlaced(grid(across), ["top", "left", "right", "bottom"]), true, "top first spans the width");
  assert.equal(windowSidebarsPlaced(grid(across), ORDER), false, "a left sidebar below the top sidebar was accepted with left first");
  assert.equal(windowSidebarsPlaced(grid(between, { top: { h: 220 } }), ORDER), false, "a top sidebar taller than its saved height was accepted");
});
