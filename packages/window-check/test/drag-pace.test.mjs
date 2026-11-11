import assert from "node:assert/strict";
import test from "node:test";
import { drag } from "../app.mjs";

// A drag that does not run at the asked rate measured nothing, and a second drag that does would make the check pass by
// chance, so the first drag that is not paced fails the check with the values that tell its cause.
function session(answers, calls) {
  return {
    app: { name: "mygo" },
    client: { endpoint: { pid: 4242 } },
    get: async () => ({ active: false, occluded: false }),
    presented: async () => ({ displayed: 12 }),
    trackRecording() {},
    request: async (method, params) => {
      calls.push(method);
      if (method === "diagnostics.drag") return answers.shift();
      if (method === "diagnostics.window.draw-covered") return null;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

const plan = { axis: "x", line: 0, dx: 10, dy: 0, ms: 400, times: 2 };

test("a drag that is not paced fails at once with its took, asked, press waits, range and load", { timeout: 5000 }, async () => {
  const calls = [];
  const slow = { took: 1700, asked: 800, pressWaits: [4, 31] };
  const failure = await drag(session([slow, { took: 800, asked: 800, pressWaits: [3, 5] }], calls), plan)
    .then(() => null, (error) => error.message);
  assert.notEqual(failure, null, "a drag that took 1700ms for 800ms passed after a second drag");
  assert.equal(calls.filter((method) => method === "diagnostics.drag").length, 1, `the drag was asked again: ${calls}`);
  assert.match(failure, /took 1700ms for 800ms/);
  assert.match(failure, /between 640ms and 1000ms/);
  assert.match(failure, /pressWaits \[4,31\]/);
  assert.match(failure, /1-minute load average \d+(\.\d+)?/);
  assert.match(failure, /a slow drag passing is not a pass/);
});

test("a drag that is paced passes after one gesture", { timeout: 5000 }, async () => {
  const calls = [];
  const result = await drag(session([{ took: 900, asked: 800, pressWaits: [3, 5] }], calls), plan);
  assert.equal(result.took, 900);
  assert.equal(calls.filter((method) => method === "diagnostics.drag").length, 1);
});
