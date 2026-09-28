import assert from "node:assert/strict";

// 기록된 새 입력만 판정한다. 회복 시도의 성공은 앞선 실패의 증거를 바꾸지 않는다.
export function assertTuiGesture({ expected, events, visual, capture, overflow, dom, pointerStart, pointerEnd, waitError }) {
  assert.equal(overflow, false, "pointer trace overflow or missing trace status");
  assert.equal(waitError, undefined, `pointer result wait failed: ${waitError}`);
  assert.ok(Array.isArray(dom) && dom.length >= 2 && pointerStart && pointerEnd, "missing pointer DOM evidence");
  const downs = dom.filter((entry) => entry.type === "pointerdown");
  const ups = dom.filter((entry) => entry.type === "pointerup");
  assert.equal(downs.length, 1, "pointer DOM down count differs from input");
  assert.equal(ups.length, 1, "pointer DOM up count differs from input");
  const downIndex = dom.indexOf(downs[0]);
  const upIndex = dom.indexOf(ups[0]);
  assert.ok(downIndex < upIndex, "pointer DOM up preceded down");
  for (const [actual, target, phase] of [[downs[0], pointerStart, "down"], [ups[0], pointerEnd, "up"]]) {
    assert.ok(Math.abs(actual.x - target.x) <= 2 && Math.abs(actual.y - target.y) <= 2,
      `pointer DOM ${phase} at ${actual.x},${actual.y} differs from ${target.x},${target.y}`);
  }
  assert.ok(dom.slice(downIndex + 1, upIndex).every((entry) => entry.type !== "pointermove" || entry.buttons === 1),
    "pointer DOM drag moved without pressed button");
  assert.ok(expected.length >= 3, "missing drag input");
  assert.equal(expected[0].phase, "down", "missing input down");
  assert.equal(expected.at(-1).phase, "up", "missing input up");
  assert.equal(new Set(expected.map((entry) => entry.inputId)).size, expected.length, "duplicate input identity");
  assert.deepEqual(events.map(({ inputId, phase }) => ({ inputId, phase })), expected,
    "input results are missing, stale, duplicated, or out of order");
  for (const event of events) {
    assert.ok(event.error == null, `input error: ${event.error}`);
    // 같은 칸 안의 움직임은 VT 계약에 따라 보고하지 않지만 down/up은 반드시 보고한다.
    if (event.phase !== "move" || event.reported) {
      assert.equal(event.reported, true, "drag was not reported");
      assert.equal(event.written, true, "drag was not written to PTY");
      assert.ok(typeof event.bytes === "string" && event.bytes.length > 0, "missing PTY bytes");
    }
  }
  assert.ok(visual?.expectedCells?.length > 0, "missing expected selection cells");
  assert.deepEqual(visual.selectedCells, visual.expectedCells, "visible selection differs from expected cells");
  assert.deepEqual(visual.recordedCells, visual.expectedCells, "recorded selection differs from expected cells");
  assert.ok(capture && [capture.first, capture.last, capture.inputStart, capture.inputEnd,
    capture.frameCount, capture.maxGap].every(Number.isFinite), "missing capture evidence");
  assert.ok(capture.frameCount >= 2 && capture.first <= capture.inputStart && capture.last >= capture.inputEnd,
    "capture does not cover the complete input");
  assert.ok(capture.maxGap <= 100, `capture frame gap ${capture.maxGap} exceeds 100ms`);
}

export function assertTuiCycle({ first, direct }) {
  assertTuiGesture(first);
  assertTuiGesture(direct);
}
