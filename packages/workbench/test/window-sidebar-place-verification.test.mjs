import assert from "node:assert/strict";
import test from "node:test";
import { windowSidebarsPlaced } from "../verify-checks.js";

/** 가로 선 xs, 세로 선 두 개, 그려진 폭 drawn 을 가진 판. */
function grid(cards, drawn = {}) {
  return {
    cards,
    rect: (id) => ({ w: drawn[id] ?? 190 }),
    lines: (axis) => axis === "x" ? [0, 1, 2, 3] : [0, 1],
  };
}
const side = (id, c0, extra = {}) => ({ id, width: 190, c0, c1: c0 + 1, r0: 0, r1: 1, fixed: true, ...extra });

test("placement verification accepts one full-height sidebar at each window edge", () => {
  assert.equal(windowSidebarsPlaced(grid([side("left", 0), side("right", 2)])), true);
});

test("placement verification checks every window sidebar's requested extent", () => {
  assert.equal(windowSidebarsPlaced(grid([side("left", 0)], { left: 210 })), false, "a sidebar wider than its saved width was accepted");
  assert.equal(windowSidebarsPlaced(grid([side("right", 1), side("right", 2)])), false, "two right columns were accepted");
  assert.equal(windowSidebarsPlaced(grid([side("left", 1)])), false, "a left sidebar away from the window edge was accepted");
  assert.equal(windowSidebarsPlaced(grid([side("left", 0, { r1: 0 })])), false, "a sidebar shorter than the window was accepted");
});
