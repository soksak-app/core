// Checks the verification state that core.verify holds after a layout failure. A failed layout is the failure of the page
// layout until a later render is presented; verificationRows composes the rows of the current state, so a state that
// nothing verifies (no plane or the library shown) holds no stale failed row (docs/spec/hosts.md#application-log).
// This test fakes only the compositor and the animation frame.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createErrorDisplay, createPageLayout, verificationRows } from "../page-layout.js";

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
    setVerify: () => {},
    log: () => {},
    surfaces: { waitPresented: async () => {} },
    plane: {},
    compositor: { publishAhead: () => (state.fail ? Promise.reject(new Error(TIMEOUT)) : Promise.resolve()) },
    textSize: () => 1,
    rendered: async () => {},
    waitSurfaceCompositionDeclared: async () => {},
  });
}

test("a presentation after a failed presentation ends the failure of the page layout", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40);
  await settle();
  assert.equal(await page.presented(), false, "the failed layout must not be presented");
  assert.equal(page.failure()?.message, TIMEOUT, "the failed layout must be the failure of the page layout");

  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40);
  await settle();
  assert.equal(await page.presented(), true, "the layout after the failure must be presented");
  page.clearFailure();
  assert.equal(page.failure(), null, "a later presentation must end the failure of the page layout");
});

test("with no plane shown, a cleared failure leaves no failed row in the verification rows", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40);
  await settle();
  await page.presented();
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40);
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
  page.onLayout(new Map(), () => {}, new Map(), 40);
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
