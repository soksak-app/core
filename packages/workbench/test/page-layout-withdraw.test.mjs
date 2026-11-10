// The banner of a failed layout is withdrawn by the presentation of a later render, and a failed wait for that presentation asks again
// only at the next presented render, never on a timer (core.workbench.error in docs/spec/exposure.md).
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { armLayoutFault, createPageLayout } from "../page-layout.js";

test("a failed presentation wait withdraws nothing, sets no timer, and the next presented render asks again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let asks = 0;
    const answers = [Promise.reject(new Error("surface s did not present")), Promise.resolve()];
    answers[0].catch(() => {});
    const withdrawn = [];
    const page = createPageLayout({
      document: null, showError: () => {}, withdrawError: (source) => withdrawn.push(source), setVerify: () => {}, log: () => {},
      surfaces: { waitPresented: () => answers[asks++] }, plane: { clear: () => {} },
      compositor: { publishAhead: () => Promise.resolve(), publish: () => {}, cancelPrepared: () => Promise.resolve() },
      textSize: () => 1, rendered: () => Promise.resolve(), waitSurfaceCompositionDeclared: () => Promise.resolve(),
    });
    armLayoutFault();
    page.onLayout({}, () => {}, [], 0, () => true);
    assert.equal(await page.presented(), false);
    asks = 0;
    page.clearFailure();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    mock.timers.tick(10_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(asks, 1, "a timer asked the host again after a failed presentation wait");
    assert.deepEqual(withdrawn, []);
    page.clearFailure();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(asks, 2, "the next presented render did not ask again");
    assert.deepEqual(withdrawn, ["layout"]);
  } finally {
    mock.timers.reset();
  }
});
