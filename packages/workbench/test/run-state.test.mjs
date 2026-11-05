// Checks the state of a run that the compositor reports and that the view subscriptions read.
import assert from "node:assert/strict";
import test from "node:test";
import { onRunEnd, onRunStart, runActive, setRunActive } from "../run-state.js";

test("a run calls each end listener once at its end, until the listener is removed", () => {
  let ends = 0;
  const off = onRunEnd(() => { ends += 1; });
  setRunActive(true);
  assert.equal(runActive(), true);
  assert.equal(ends, 0, "the start of a run called an end listener");
  setRunActive(false);
  setRunActive(false);
  assert.equal(runActive(), false);
  assert.equal(ends, 1, "an end listener did not run exactly once");
  off();
  setRunActive(true);
  setRunActive(false);
  assert.equal(ends, 1, "a removed end listener ran");
});

test("a run that starts calls each listener of its start once", () => {
  let starts = 0;
  const off = onRunStart(() => { starts += 1; });
  setRunActive(true);
  setRunActive(true);
  assert.equal(starts, 1);
  setRunActive(false);
  off();
  setRunActive(true);
  setRunActive(false);
  assert.equal(starts, 1, "an off function ends the listener");
});
