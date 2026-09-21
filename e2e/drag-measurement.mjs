import assert from "node:assert/strict";

// 실제 캡처 좌표로 왕복 횟수와 시작점 복귀를 확인한다. 정지한 화면은 통과할 수 없다.
export function assertRoundTrips(positions, times) {
  assert.ok(positions.length > 1 && positions.every(Number.isFinite), "drag positions are missing or invalid");
  const low = Math.min(...positions), high = Math.max(...positions);
  const span = high - low;
  assert.ok(span >= 50, `the card moved only ${span}pt; the requested drag was not recorded`);
  const ends = [];
  for (const position of positions) {
    const end = position <= low + span * .2 ? "low" : position >= high - span * .2 ? "high" : null;
    if (end && ends.at(-1) !== end) ends.push(end);
  }
  assert.equal(ends.length, times * 2 + 1,
    `expected ${times} complete round trips, observed ${ends.join(",")}; positions: ${positions.join(",")}`);
  assert.equal(ends[0], ends.at(-1), "the recorded drag did not return to its starting end");
  assert.ok(Math.abs(positions[0] - positions.at(-1)) <= 1,
    `the recorded card must return to its initial position: ${positions[0]} → ${positions.at(-1)}`);
  return span;
}
