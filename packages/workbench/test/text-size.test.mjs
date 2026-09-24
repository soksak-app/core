import assert from "node:assert/strict";
import test from "node:test";
import { TEXT_STEPS, nextTextSize, onTextScope, setTextScope, textScope } from "../text-size.js";

test("text size moves through the declared steps and stops at the ends", () => {
  assert.deepEqual(TEXT_STEPS, [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
  assert.equal(nextTextSize(1, 1), 1.1);
  assert.equal(nextTextSize(1, -1), 0.9);
  assert.equal(nextTextSize(2.5, 0), 1);
  assert.equal(nextTextSize(3, 1), 3);
  assert.equal(nextTextSize(0.5, -1), 0.5);
});

test("a text size outside the steps or an unknown direction is an error", () => {
  assert.throws(() => nextTextSize(1.3, 1), /not a step/);
  assert.throws(() => nextTextSize(1, 2), /direction/);
});

test("the text scope is a card or the frame and reports each change", () => {
  const seen = [];
  const stop = onTextScope((scope) => seen.push(scope));
  assert.equal(textScope(), null, "the window starts with the focused card as the scope");
  setTextScope({ kind: "card", card: "c1" });
  setTextScope({ kind: "frame" });
  assert.deepEqual(textScope(), { kind: "frame" });
  assert.deepEqual(seen, [{ kind: "card", card: "c1" }, { kind: "frame" }]);
  assert.throws(() => setTextScope({ kind: "card" }), /card/);
  assert.throws(() => setTextScope({ kind: "window" }), /scope/);
  stop();
});
