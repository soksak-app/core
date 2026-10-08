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

test("content with a new scroll key that asks for the end starts at its end, and a known key keeps its position", () => {
  const known = { dataset: { scrollKey: "view:a", scrollEnd: "" }, scrollTop: 0, scrollLeft: 0, scrollHeight: 900 };
  const positions = scrollPositions(rootOf({ ...known, scrollTop: 120 }));
  const fresh = { dataset: { scrollKey: "view:b", scrollEnd: "" }, scrollTop: 0, scrollLeft: 0, scrollHeight: 900 };
  const top = { dataset: { scrollKey: "list" }, scrollTop: 0, scrollLeft: 0, scrollHeight: 900 };
  restoreScroll(rootOf(known, fresh, top), positions);
  assert.deepEqual([known.scrollTop, fresh.scrollTop, top.scrollTop], [120, 900, 0]);
});
