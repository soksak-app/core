import assert from "node:assert/strict";
import test from "node:test";
import { assertTuiGesture, assertTuiCycle } from "../tui-drag-measurement.mjs";

function complete() {
  const expected = ["down", "move", "up"].map((phase, index) => ({ inputId: `new-${index}`, phase }));
  return {
    expected,
    events: expected.map((item) => ({ ...item, reported: true, written: true, bytes: "eA==", error: null })),
    visual: { expectedCells: ["2:3", "2:4"], selectedCells: ["2:3", "2:4"], recordedCells: ["2:3", "2:4"] },
    capture: { first: 90, last: 160, inputStart: 100, inputEnd: 150, frameCount: 5, maxGap: 20 },
    dom: [
      { type: "pointerdown", x: 10, y: 12, buttons: 1 },
      { type: "pointermove", x: 20, y: 12, buttons: 1 },
      { type: "pointerup", x: 30, y: 12, buttons: 0 },
    ],
    pointerStart: { x: 10, y: 12 },
    pointerEnd: { x: 30, y: 12 },
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
test("the final recorded frame must show every selected text cell", () => {
  const attempt = complete();
  attempt.visual.recordedCells = ["2:3"];
  assert.throws(() => assertTuiGesture(attempt), /recorded selection/);
});
test("a direct retry waits for a fresh terminal selection after release", () => {
  const attempt = complete();
  attempt.selectionWaitMs = 1000;
  attempt.selectionWaitError = "selection status timed out";
  assert.throws(() => assertTuiGesture(attempt), /selection.*status/);
});
test("a gesture that reforms the selection over a pre-existing one passes", () => {
  const attempt = complete();
  attempt.selectionWaitMs = 1000;
  attempt.selectionByFrame = [
    { time: 0, selectedCells: ["2:3", "2:4"] },
    { time: 40, selectedCells: [] },
    { time: 80, selectedCells: ["2:3"] },
    { time: 120, selectedCells: ["2:3", "2:4"] },
  ];
  assert.doesNotThrow(() => assertTuiGesture(attempt));
});
test("a recording that never forms the selection cannot pass", () => {
  const attempt = complete();
  attempt.selectionWaitMs = 1000;
  attempt.selectionByFrame = [
    { time: 0, selectedCells: ["2:3", "2:4"] },
    { time: 120, selectedCells: ["2:3", "2:4"] },
  ];
  assert.throws(() => assertTuiGesture(attempt), /forming/);
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
test("an early pointer-up or absent pointer-down fails even if the final PTY report exists", () => {
  for (const change of [
    (a) => { a.dom.splice(0, 1); },
    (a) => { a.dom.splice(2, 0, { type: "pointerup", x: 22, y: 12, buttons: 0 }); },
    (a) => { a.dom.at(-1).x = 22; },
  ]) {
    const attempt = complete();
    change(attempt);
    assert.throws(() => assertTuiGesture(attempt), /pointer/);
  }
});
