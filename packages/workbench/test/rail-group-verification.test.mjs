import assert from "node:assert/strict";
import test from "node:test";
import { expectedRailLoops } from "../verify-checks.js";

test("rail verification counts connected outlines per associated group", () => {
  const rect = (x) => ({ x, y: 0, w: 100, h: 100 });
  // 첫 묶음의 두 사각형은 간격 8 안에서 이어지고, 둘째 묶음의 두 사각형은 떨어져 있다.
  const groups = [{ rects: [rect(0), rect(108)] }, { rects: [rect(250), rect(500)] }];
  assert.equal(expectedRailLoops(groups, 8), 3);
  assert.equal(expectedRailLoops([{ rects: [rect(0), rect(109)] }], 8), 2, "a gap wider than the card gap separates the outlines");
});
