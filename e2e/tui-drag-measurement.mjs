import assert from "node:assert/strict";

// Judges only new recorded input. The success of a recovery attempt does not change the evidence of the earlier failure.
export function assertTuiGesture({ expected, events, visual, capture, overflow, dom, pointerStart, pointerEnd, waitError,
  selectionByFrame, selectionWaitError, selectionWaitMs }) {
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
    // Motion within the same cell is not reported by the VT contract, but down/up must always be reported.
    if (event.phase !== "move" || event.reported) {
      assert.equal(event.reported, true, "drag was not reported");
      assert.equal(event.written, true, "drag was not written to PTY");
      assert.ok(typeof event.bytes === "string" && event.bytes.length > 0, "missing PTY bytes");
    }
  }
  assert.ok(visual?.expectedCells?.length > 0, "missing expected selection cells");
  assert.deepEqual(visual.selectedCells, visual.expectedCells, "visible selection differs from expected cells");
  assert.deepEqual(visual.recordedCells, visual.expectedCells, "recorded selection differs from expected cells");
  if (selectionWaitMs !== undefined) {
    assert.equal(selectionWaitError, undefined, `selection status did not arrive: ${selectionWaitError}`);
    assert.ok(selectionWaitMs <= 1050, `selection appeared after ${selectionWaitMs}ms`);
    // A selection that stays until the next gesture is correct behavior, so instead of a precondition of integrity, requires that the selection was
    // formed within this recording. The down of a drag breaks the earlier selection and makes a new one, so a less selected frame is always captured before the
    // fully selected frame. A recording that shows the same selection from start to end
    // is not a result of this gesture.
    const counts = (selectionByFrame ?? []).map((frame) => frame.selectedCells.length);
    const want = visual.expectedCells.length;
    assert.ok(counts.some((count, index) => count < want && counts.lastIndexOf(want) > index),
      "the recording never shows the selection forming during the gesture");
  }
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

/**
 * The DOM pointer events of this gesture among the recorded entries. The check starts recording right after it sends the preceding click, so the pointerup of that click may be at the start
 * of the record. The gesture starts at the first pointerdown, so events before it belong to the preceding input. When there is no pointerdown,
 * it returns all events so that the judgement reports the missing down.
 */
export function gestureDom(entries) {
  const dom = entries.filter((entry) => entry.kind === "pointer-dom");
  const down = dom.findIndex((entry) => entry.type === "pointerdown");
  return down < 0 ? dom : dom.slice(down);
}
