import assert from "node:assert/strict";
import test from "node:test";

import { runReferenceSteps } from "./ime-reference-steps.mjs";

test("the next AppKit reference key waits for the prior presentation checkpoint", { timeout: 5000 }, async () => {
  let releasePresentation;
  let reachedPresentation;
  let reachedSecondKey;
  const presentationGate = new Promise((resolve) => { releasePresentation = resolve; });
  const presentationStarted = new Promise((resolve) => { reachedPresentation = resolve; });
  const secondKeyStarted = new Promise((resolve) => { reachedSecondKey = resolve; });
  const calls = [];

  const run = runReferenceSteps(["k", "k"], {
    async press(key, index) {
      calls.push(`press:${index}`);
      if (index === 1) reachedSecondKey();
    },
    async read(key, index) {
      calls.push(`read:${index}`);
      return { key, index };
    },
    async verify(state, key, index) {
      assert.deepEqual(state, { key, index });
      calls.push(`verify:${index}`);
    },
    async presented(key, index) {
      calls.push(`presented:${index}`);
      if (index === 0) {
        reachedPresentation();
        await presentationGate;
      }
    },
  });

  const first = await Promise.race([
    presentationStarted.then(() => "presentation"),
    secondKeyStarted.then(() => "second-key"),
    run.then(() => "finished"),
  ]);
  assert.equal(first, "presentation", "the second key started before the first key's presentation checkpoint");
  assert.deepEqual(calls, ["press:0", "read:0", "verify:0", "presented:0"]);

  releasePresentation();
  await run;
  assert.deepEqual(calls, ["press:0", "read:0", "verify:0", "presented:0",
    "press:1", "read:1", "verify:1", "presented:1"]);
});
