import assert from "node:assert/strict";
import test from "node:test";
import { expectedRailLoops } from "../verify-checks.js";

test("rail verification counts connected outlines per associated group", () => {
  const rect = (x) => ({ x, y: 0, w: 100, h: 100 });
  // The two rectangles of the first group connect within the gap of 8, and the two rectangles of the second group are apart.
  const groups = [{ rects: [rect(0), rect(108)] }, { rects: [rect(250), rect(500)] }];
  assert.equal(expectedRailLoops(groups, 8), 3);
  assert.equal(expectedRailLoops([{ rects: [rect(0), rect(109)] }], 8), 2, "a gap wider than the card gap separates the outlines");
});
