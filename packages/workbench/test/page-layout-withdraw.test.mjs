// The banner of a failed layout is withdrawn by the presentation of a later render, and a failed wait for that presentation asks again
// only at the next presented render, never on a timer (core.workbench.error in docs/spec/exposure.md). The test settles each wait
// for a presentation itself, and setTimeout is watched so that the test finds that no timer is started.
import assert from "node:assert/strict";
import test from "node:test";
import { armLayoutFault, createPageLayout } from "../page-layout.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("a failed presentation wait withdraws nothing, sets no timer, and the next presented render asks again", async (t) => {
  const answers = [];
  const withdrawn = [];
  const page = createPageLayout({
    document: null, showError: () => {}, withdrawError: (source) => withdrawn.push(source), setVerify: () => {}, log: () => {},
    surfaces: { waitPresented: () => { const answer = deferred(); answers.push(answer); return answer.promise; } },
    plane: { clear: () => {} },
    compositor: { publishAhead: () => Promise.resolve(), publish: () => {}, cancelPrepared: () => Promise.resolve() },
    textSize: () => 1, rendered: () => Promise.resolve(), waitSurfaceCompositionDeclared: () => Promise.resolve(),
  });
  armLayoutFault();
  page.onLayout({}, () => {}, [], 0, () => true);
  assert.equal(await page.presented(), false);
  assert.equal(answers.length, 0, "a failed layout asked the host for its presentation");
  const timers = t.mock.method(globalThis, "setTimeout", () => 0);
  page.clearFailure();
  assert.equal(answers.length, 1, "a presented render did not ask for the presentation");
  // The wait of the page registered its handlers before the test, so they have run when the awaited rejection settles here.
  answers[0].reject(new Error("surface s did not present"));
  await answers[0].promise.catch(() => {});
  assert.equal(timers.mock.callCount(), 0, "a failed presentation wait started a timer to ask the host again");
  assert.equal(answers.length, 1, "a failed presentation wait asked the host again before the next presented render");
  assert.deepEqual(withdrawn, []);
  page.clearFailure();
  assert.equal(answers.length, 2, "the next presented render did not ask again");
  answers[1].resolve();
  await answers[1].promise;
  assert.deepEqual(withdrawn, ["layout"]);
  assert.equal(timers.mock.callCount(), 0);
});
