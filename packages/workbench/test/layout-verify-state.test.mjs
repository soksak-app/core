// Checks the verification state that core.verify holds after a layout failure. A failed layout is the failure of the page
// layout until a later render is presented; verificationRows composes the rows of the current state, so a state that
// nothing verifies (no plane or the library shown) holds no stale failed row (docs/spec/hosts.md#application-log).
// This test fakes only the compositor and the animation frame.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createErrorDisplay, createErrorWithdrawal, createPageLayout, verificationRows } from "../page-layout.js";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

const dom = new JSDOM('<header></header><div id="applicationError"></div>');
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = (run) => run(0);

/** Finishes the microtasks and the reporting of the layout queue up to the next macrotask. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Creates the page layout whose presentation fails while fail is true. */
function layoutWith(state) {
  return createPageLayout({
    document,
    showError: createErrorDisplay({ document, changed: () => {} }),
    withdrawError: createErrorWithdrawal({ document, changed: () => {} }),
    setVerify: () => {},
    log: () => {},
    surfaces: { waitPresented: () => state.presented?.() ?? Promise.resolve() },
    plane: {},
    compositor: { publishAhead: () => (state.fail ? Promise.reject(new Error(TIMEOUT)) : Promise.resolve()), cancelPrepared: async () => {} },
    textSize: () => 1,
    rendered: async () => {},
    waitSurfaceCompositionAnswered: async () => {},
  });
}

test("a presentation after a failed presentation ends the failure of the page layout", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  assert.equal(await page.presented(), false, "the failed layout must not be presented");
  assert.equal(page.failure()?.message, TIMEOUT, "the failed layout must be the failure of the page layout");

  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  assert.equal(await page.presented(), true, "the layout after the failure must be presented");
  page.clearFailure();
  assert.equal(page.failure(), null, "a later presentation must end the failure of the page layout");
});

test("a presentation after a failed presentation withdraws the error of that failure from the banner", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /surface presentation failed/);
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  page.clearFailure();
  await settle();
  assert.equal(document.getElementById("applicationError"), null, "the banner keeps the failure of a layout that recovered");
});

test("a presentation after a failed presentation leaves another error in the banner", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  const showError = createErrorDisplay({ document, changed: () => {} });
  showError("another failure");
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  page.clearFailure();
  await settle();
  assert.equal(document.getElementById("applicationError")?.textContent, "another failure");
  document.getElementById("applicationError").remove();
});

test("while a surface has not presented, the presentation of another render leaves the failure, and the presentation of that surface withdraws it", async () => {
  let presentedNow;
  const state = { fail: true, presented: () => new Promise((resolve) => { presentedNow = resolve; }) };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  page.clearFailure();
  await settle();
  assert.equal(page.failure(), null, "a later presentation must end the failure of the page layout");
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /did not present/, "the error is still true");
  presentedNow();
  await settle();
  assert.equal(document.getElementById("applicationError"), null, "the surface presented and the banner kept the failure");
});

// A wait that ends without the presentation asks nothing again by itself: the next presented render asks again.
test("a wait for the surfaces that fails leaves the failure, and the next presented render asks again and withdraws it", async () => {
  let asked = 0;
  const state = { fail: true, presented: () => (++asked === 1 ? Promise.reject(new Error(TIMEOUT)) : Promise.resolve()) };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  state.fail = false;
  page.clearFailure();
  await settle();
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /did not present/);
  assert.equal(asked, 1, "a failed wait asked the surfaces again before the next presented render");
  page.clearFailure();
  await settle();
  assert.equal(asked, 2);
  assert.equal(document.getElementById("applicationError"), null);
});

test("a layout that fails during the wait keeps its failure", async () => {
  let presentedNow;
  const state = { fail: true, presented: () => new Promise((resolve) => { presentedNow = resolve; }) };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  page.clearFailure();
  await settle();
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  presentedNow();
  await settle();
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /did not present/);
  document.getElementById("applicationError").remove();
});

test("a failure that repeats stays in the banner", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  for (let round = 0; round < 2; round++) {
    page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
    await settle();
    await page.presented();
  }
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /surface presentation failed/);
  document.getElementById("applicationError").remove();
});

test("an error of another source with the text of the failure stays in the banner", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  const text = document.getElementById("applicationError").textContent;
  createErrorDisplay({ document, changed: () => {} })(text);
  page.clearFailure();
  await settle();
  assert.equal(document.getElementById("applicationError")?.textContent, text);
  document.getElementById("applicationError").remove();
});

test("with no plane shown, a cleared failure leaves no failed row in the verification rows", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  page.clearFailure();
  // The library is shown: nothing is verified, so the rows are empty and the earlier failed row is not kept.
  const rows = verificationRows({ drawn: false, rows: () => { throw new Error("rows must not be read without a plane"); }, failure: page.failure() });
  assert.deepEqual(rows, [], "a state without a plane must report no rows after the failure is cleared");
});

test("with no plane shown, a failure that is still current is the only row", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await settle();
  await page.presented();
  const rows = verificationRows({ drawn: false, rows: () => { throw new Error("rows must not be read without a plane"); }, failure: page.failure() });
  assert.deepEqual(rows, [{ name: "Surface presentation", ok: false, note: TIMEOUT }],
    "a current layout failure must be reported even when no plane is shown");
});

test("with a plane shown, the verification rows and the current failure are reported", () => {
  const pass = { name: "V1", ok: true, note: "" };
  assert.deepEqual(verificationRows({ drawn: true, rows: () => [pass], failure: null }), [pass]);
  assert.deepEqual(verificationRows({ drawn: true, rows: () => [pass], failure: new Error(TIMEOUT) }), [
    pass, { name: "Surface presentation", ok: false, note: TIMEOUT },
  ]);
});
