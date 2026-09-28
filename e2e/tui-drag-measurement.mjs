import assert from "node:assert/strict";

// 기록된 새 입력만 판정한다. 회복 시도의 성공은 앞선 실패의 증거를 바꾸지 않는다.
export function assertTuiGesture({ expected, events, visual, capture, overflow }) {
  assert.equal(overflow, false, "pointer trace overflow or missing trace status");
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
