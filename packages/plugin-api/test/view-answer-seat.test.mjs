// Checks the route of the view call runtime.seat.height in answerViewCall (docs/spec/plugins.md#settings-views): the height reaches the
// runtime of the seat with the calling surface, and a height that is negative, not finite or not a number is refused before it reaches it.
import assert from "node:assert/strict";
import test from "node:test";
import { answerViewCall } from "../view-answer.js";

/** The options of answerViewCall for the view of surface, whose runtime records each seat height in heights. */
function optionsWith(heights, surface = "settings/probe") {
  return { plugin: "probe", surface, pending: new Map(), emitEvent() {}, runtime: { seat: { height: (from, height) => { heights.push({ from, height }); } } } };
}

test("runtime.seat.height passes the height of the calling surface to the seat and replies null", async () => {
  const heights = [];
  assert.equal(await answerViewCall({ id: 1, command: "runtime.seat.height", params: { height: 180 } }, optionsWith(heights)), null);
  assert.equal(await answerViewCall({ id: 2, command: "runtime.seat.height", params: { height: 0 } }, optionsWith(heights)), null);
  assert.deepEqual(heights, [{ from: "settings/probe", height: 180 }, { from: "settings/probe", height: 0 }]);
});

test("runtime.seat.height refuses a height that is negative, not finite or not a number, and sets no seat", async () => {
  const heights = [];
  for (const params of [{ height: -1 }, { height: Number.NaN }, { height: Number.POSITIVE_INFINITY }, { height: "180" }, {}]) {
    await assert.rejects(answerViewCall({ id: 3, command: "runtime.seat.height", params }, optionsWith(heights)),
      /^TypeError: view call runtime.seat.height requires a height that is not negative$/);
  }
  assert.deepEqual(heights, []);
});

test("runtime.seat.height of a view that is not a settings surface is refused by the seat with its error", async () => {
  const options = optionsWith([], "tab-a");
  options.runtime.seat.height = () => { throw new Error(`view call runtime.seat.height is served only for a settings surface`); };
  await assert.rejects(answerViewCall({ id: 4, command: "runtime.seat.height", params: { height: 10 } }, options),
    /view call runtime.seat.height is served only for a settings surface/);
});
