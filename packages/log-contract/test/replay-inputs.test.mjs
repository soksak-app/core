// The golden cases of the replay inputs (docs/spec/replay.md#records): the fields of each input kind, including the selection, the
// viewport and the theme, and the rules of a session (a theme first, a sequence without a gap, an update after a start).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REPLAY_INPUT_KINDS, replayInputProblem, replaySessionProblem } from "../index.js";

const cases = JSON.parse(readFileSync(new URL("../fixtures/replay/inputs.json", import.meta.url), "utf8"));

test("the kinds of replay input are output, write, resize, selection, viewport and theme", () => {
  assert.deepEqual(REPLAY_INPUT_KINDS, ["output", "write", "resize", "selection", "viewport", "theme"]);
});

for (const valid of cases.valid) {
  test(`the replay input "${valid.name}" has no problem`, () => {
    assert.equal(replayInputProblem(valid.kind, valid.fields), null);
  });
}

for (const invalid of cases.invalid) {
  test(`the replay input "${invalid.name}" is refused with the text of the case`, () => {
    assert.equal(replayInputProblem(invalid.kind, invalid.fields), invalid.error);
  });
}

for (const session of cases.sessions) {
  test(`the session "${session.name}" ${session.problem === null ? "has no problem" : "is refused"}`, () => {
    assert.equal(replaySessionProblem(session.inputs), session.problem);
  });
}
