import assert from "node:assert/strict";
import test from "node:test";
import { assertTuiGesture, assertTuiCycle } from "../tui-drag-measurement.mjs";

function complete() {
  const expected = ["down", "move", "up"].map((phase, index) => ({ inputId: `new-${index}`, phase }));
  return {
    expected,
    events: expected.map((item) => ({ ...item, reported: true, written: true, bytes: "eA==", error: null })),
    visual: { expectedCells: ["2:3", "2:4"], selectedCells: ["2:3", "2:4"] },
    capture: { first: 90, last: 160, inputStart: 100, inputEnd: 150, frameCount: 5, maxGap: 20 },
    overflow: false,
  };
}

test("a complete correlated TUI gesture passes", () => assertTuiGesture(complete()));
test("an earlier mouse-up cannot complete a new gesture", () => {
  const attempt = complete();
  attempt.events = [{ ...attempt.events.at(-1), inputId: "previous-up" }];
  assert.throws(() => assertTuiGesture(attempt), /input/);
});
test("recovery cannot erase a failed direct retry", () => {
  const direct = complete();
  direct.events.at(-1).written = false;
  assert.throws(() => assertTuiCycle({ first: complete(), direct, recovery: complete() }), /written/);
});
test("PTY write success without the required visible selection fails", () => {
  const attempt = complete();
  attempt.visual.selectedCells = [];
  assert.throws(() => assertTuiGesture(attempt), /selection/);
});
test("incomplete input or capture evidence fails", () => {
  for (const change of [
    (a) => a.events.splice(1, 1),
    (a) => { a.capture.last = 120; },
    (a) => { a.capture.maxGap = 101; },
    (a) => { a.overflow = true; },
  ]) {
    const attempt = complete();
    change(attempt);
    assert.throws(() => assertTuiGesture(attempt));
  }
});
