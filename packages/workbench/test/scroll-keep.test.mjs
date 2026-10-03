import assert from "node:assert/strict";
import test from "node:test";

import { restoreScroll, scrollPositions } from "../scroll-keep.js";

/** data-scroll-key 요소들을 가진 root. */
function rootOf(...elements) {
  return { querySelectorAll: (selector) => (selector === "[data-scroll-key]" ? elements : []) };
}

test("a redraw with the same scroll key keeps the position and another key starts at the top", () => {
  const before = { dataset: { scrollKey: "general:common" }, scrollTop: 240, scrollLeft: 0 };
  const positions = scrollPositions(rootOf(before));
  const same = { dataset: { scrollKey: "general:common" }, scrollTop: 0, scrollLeft: 0 };
  const other = { dataset: { scrollKey: "plugins:common" }, scrollTop: 0, scrollLeft: 0 };
  restoreScroll(rootOf(same, other), positions);
  assert.deepEqual([same.scrollTop, other.scrollTop], [240, 0]);
});
