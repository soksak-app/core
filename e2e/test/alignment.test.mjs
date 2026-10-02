import assert from "node:assert/strict";
import test from "node:test";

import { alignmentDelta } from "../alignment.mjs";

const initial = { contentLeft: 1, contentRight: 1, sidebar: 13, rail: 6 };

test("a terminal raster that lags inside its card on the right is aligned", () => {
  // 크기가 바뀌는 동안 터미널은 이전 크기의 래스터를 왼쪽에 붙여 보인다. 오른쪽 안쪽 여백이 커질 뿐 카드 밖으로
  // 나가지 않는다.
  assert.equal(alignmentDelta(initial, { ...initial, contentRight: 131 }), 0);
});

test("content that crosses the card edge or moves its left edge is not aligned", () => {
  assert.equal(alignmentDelta(initial, { ...initial, contentRight: -3 }), 4);
  assert.equal(alignmentDelta(initial, { ...initial, contentLeft: 5 }), 4);
  assert.equal(alignmentDelta(initial, { ...initial, rail: 9 }), 3);
});
