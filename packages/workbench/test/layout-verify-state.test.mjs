// Checks the verification state that core.verify holds after a layout failure. A failed layout is the failure of the page
// layout until a later render is presented; verificationRows composes the rows of the current state, so a state that
// nothing verifies (no plane or the library shown) holds no stale failed row (docs/spec/hosts.md#application-log).
// The compositor is the real one: its commit listener (onCommit) answers with the failed presentation, and the waits for the presentation of
// the window are calls that the page-wire cases of this test answer (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { drained } from "./support/drained.mjs";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

// The page-wire case of the first test is selected before host.js is imported, because host.js reads the host when it is imported.
let wire = selectPageWire("layout-verify-state-recovered-ends-failure");

const dom = new JSDOM('<header></header><div id="plane"></div><div id="applicationError"></div>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { surfaces } = await import("../host.js");
const { flushEvents } = await import("../page-log.js");
const { onCommit, publishAhead, cancelPrepared } = await import("../compositor.js");
const { createErrorDisplay, createErrorWithdrawal, createPageLayout, verificationRows } = await import("../page-layout.js");

/**
 * Creates the page layout whose preparation fails while state.fail is true: the commit listener of the compositor answers with the failure
 * that the host reports for a presentation that did not complete.
 */
function layoutWith(state) {
  onCommit(() => (state.fail ? Promise.reject(new Error(TIMEOUT)) : Promise.resolve({ placements: [], deferred: [] })));
  return createPageLayout({
    document,
    showError: createErrorDisplay({ document, changed: () => {} }),
    withdrawError: createErrorWithdrawal({ document, changed: () => {} }),
    setVerify: () => {},
    log: () => {},
    surfaces,
    plane: {},
    compositor: { publishAhead, cancelPrepared },
    textSize: () => 1,
    rendered: async () => {},
    waitSurfaceCompositionAnswered: async () => {},
  });
}

test("a presentation after a failed presentation ends the failure of the page layout", async () => {
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  assert.equal(await page.presented(), false, "the failed layout must not be presented");
  assert.equal(page.failure()?.message, TIMEOUT, "the failed layout must be the failure of the page layout");

  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  assert.equal(await page.presented(), true, "the layout after the failure must be presented");
  page.clearFailure();
  assert.equal(page.failure(), null, "a later presentation must end the failure of the page layout");
  await drained();
  await flushEvents();
  wire.finish();
});

test("a presentation after a failed presentation withdraws the error of that failure from the banner", async () => {
  wire = selectPageWire("layout-verify-state-banner-withdrawn");
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /surface presentation failed/);
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  page.clearFailure();
  await drained();
  assert.equal(document.getElementById("applicationError"), null, "the banner keeps the failure of a layout that recovered");
  await flushEvents();
  wire.finish();
});

test("a presentation after a failed presentation leaves another error in the banner", async () => {
  wire = selectPageWire("layout-verify-state-other-error-kept");
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  const showError = createErrorDisplay({ document, changed: () => {} });
  showError("another failure");
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  page.clearFailure();
  await drained();
  assert.equal(document.getElementById("applicationError")?.textContent, "another failure");
  document.getElementById("applicationError").remove();
  await flushEvents();
  wire.finish();
});

test("while a surface has not presented, the presentation of another render leaves the failure, and the presentation of that surface withdraws it", async () => {
  wire = selectPageWire("layout-verify-state-surface-held");
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.drawn();
  page.clearFailure();
  // The wait for the surface is held until the release, so the banner keeps the failure after clearFailure.
  assert.equal(page.failure(), null, "a later presentation must end the failure of the page layout");
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /did not present/, "the error is still true");
  wire.release();
  await drained();
  assert.equal(document.getElementById("applicationError"), null, "the surface presented and the banner kept the failure");
  await flushEvents();
  wire.finish();
});

// A wait that ends without the presentation asks nothing again by itself: the next presented render asks again.
test("a wait for the surfaces that fails leaves the failure, and the next presented render asks again and withdraws it", async () => {
  wire = selectPageWire("layout-verify-state-wait-refused");
  const waits = () => wire.calls.filter(({ name }) => name === "waitPresented").length;
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  state.fail = false;
  page.clearFailure();
  // The wait rejects with the failure; the page handles that rejection, so the test only observes that it ended.
  await drained();
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /did not present/);
  assert.equal(waits(), 1, "a failed wait asked the surfaces again before the next presented render");
  page.clearFailure();
  await drained();
  assert.equal(waits(), 2);
  assert.equal(document.getElementById("applicationError"), null);
  await flushEvents();
  wire.finish();
});

test("a layout that fails during the wait keeps its failure", async () => {
  wire = selectPageWire("layout-verify-state-layout-fails-in-wait");
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  page.clearFailure();
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.drawn();
  wire.release();
  await drained();
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /did not present/);
  document.getElementById("applicationError").remove();
  await flushEvents();
  wire.finish();
});

test("a failure that repeats stays in the banner", async () => {
  wire = selectPageWire("layout-verify-state-failure-repeats");
  const state = { fail: true };
  const page = layoutWith(state);
  for (let round = 0; round < 2; round++) {
    page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
    await page.presented();
  }
  assert.match(document.getElementById("applicationError")?.textContent ?? "", /surface presentation failed/);
  document.getElementById("applicationError").remove();
  await flushEvents();
  wire.finish();
});

test("an error of another source with the text of the failure stays in the banner", async () => {
  wire = selectPageWire("layout-verify-state-same-text-other-source");
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  const text = document.getElementById("applicationError").textContent;
  createErrorDisplay({ document, changed: () => {} })(text);
  page.clearFailure();
  await drained();
  assert.equal(document.getElementById("applicationError")?.textContent, text);
  document.getElementById("applicationError").remove();
  await flushEvents();
  wire.finish();
});

test("with no plane shown, a cleared failure leaves no failed row in the verification rows", async () => {
  wire = selectPageWire("layout-verify-state-no-plane-cleared");
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  state.fail = false;
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  page.clearFailure();
  await drained();
  // The library is shown: nothing is verified, so the rows are empty and the earlier failed row is not kept.
  const rows = verificationRows({ drawn: false, rows: () => { throw new Error("rows must not be read without a plane"); }, failure: page.failure() });
  assert.deepEqual(rows, [], "a state without a plane must report no rows after the failure is cleared");
  await flushEvents();
  wire.finish();
});

test("with no plane shown, a failure that is still current is the only row", async () => {
  wire = selectPageWire("layout-verify-state-no-plane-current");
  const state = { fail: true };
  const page = layoutWith(state);
  page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  await page.presented();
  const rows = verificationRows({ drawn: false, rows: () => { throw new Error("rows must not be read without a plane"); }, failure: page.failure() });
  assert.deepEqual(rows, [{ name: "Surface presentation", ok: false, note: TIMEOUT }],
    "a current layout failure must be reported even when no plane is shown");
  await flushEvents();
  wire.finish();
});

test("with a plane shown, the verification rows and the current failure are reported", () => {
  const pass = { name: "V1", ok: true, note: "" };
  assert.deepEqual(verificationRows({ drawn: true, rows: () => [pass], failure: null }), [pass]);
  assert.deepEqual(verificationRows({ drawn: true, rows: () => [pass], failure: new Error(TIMEOUT) }), [
    pass, { name: "Surface presentation", ok: false, note: TIMEOUT },
  ]);
});
