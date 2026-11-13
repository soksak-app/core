// Checks the lines that the failure of one layout writes to the application log. The failed callback of the layout queue receives and shows that failure, so neither the project switch command
// that waited for the layout nor the gesture that scheduled the layout writes the same failure again (docs/spec/hosts.md#application-log).
// The connections are the error display of page-layout.js that index.html uses, the report of unhandled rejections, the layout receiver, and the
// presented callback of the project switch. The host calls are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md).
// The compositor that prepares a layout is a stand-in in the tests that inject a failure or hold a preparation open: the
// compositor of compositor.js reaches the host only through the listener of onCommit, which no module registers, so no
// production preparation fails with a host answer here (see the notes of each test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";
import { drained } from "./support/drained.mjs";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

// The page-wire case of the first test is selected before host.js is imported, because host.js reads the host when it is imported.
const firstWire = selectPageWire("layout-failure-lines-project-switch");

const dom = new JSDOM('<div id="applicationError"></div><button id="projectTab"></button>');
globalThis.document = dom.window.document;
const { report, surfaces } = await import("../host.js");
const { flushEvents } = await import("../page-log.js");
const { createErrorDisplay, createPageLayout, placementLast, reportUncaught } = await import("../page-layout.js");
const { hideError } = await import("../shown-errors.js");
const { connectExposure, registry } = await import("../exposure.js");
const { bind } = await import("../commands.js");

/** The log lines that the page sent in the batches of its wire, as `<level> workbench <where>: <text>`. */
const linesOf = (wire) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload?.action === "batch")
  .flatMap(({ name, payload }) => recordsOf(name, payload).map(shownRecord));

const banner = document.getElementById("applicationError");
const showError = createErrorDisplay({ document, changed: () => {} });
// The window of the document. A browser reports an unhandled rejection as an unhandledrejection event of the window.
const target = new EventTarget();
reportUncaught(target, showError);
/**
 * Sends an unhandled rejection as an event of the window. The document of an unhandled rejection receives only the report of that event, so the
 * handler of the test runner that the first test() installs is detached at the start of each test.
 */
function reportRejectionsAsPage() {
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
  });
}

// Stand-in: the preparation of the layout fails with the host text of a presentation that did not complete. No production path of
// publishAhead produces that failure (compositor.js commit calls the onCommit listener, which no module registers), so the failure is injected here.
const page = createPageLayout({
  document, showError, setVerify: () => {}, log: () => {}, surfaces,
  plane: {},
  compositor: { publishAhead: () => Promise.reject(new Error(TIMEOUT)), cancelPrepared: async () => {} },
  textSize: () => 1,
  rendered: () => Promise.resolve(),
  waitSurfaceCompositionAnswered: async () => {},
});
await connectExposure({ settled: page.drawn, report });
/** The plane schedules a layout. The preparation of that layout fails. */
const schedule = () => { page.onLayout(new Map(), () => {}, new Map(), 40, () => true); };

test("a layout failure of a project switch started from the interface writes one workbench error line", async () => {
  reportRejectionsAsPage();
  registry.declare("core", { status: [], element: [], commands: [{
    name: "core.fixture.activate", description: "Activates.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] });
  // A project switch schedules the loaded layout on the plane, waits for its presentation, and then replies (showProject of projects.js).
  // The command resolves `completed` after its layout presented or failed; the failure is queued before the presentation answers.
  const completed = Promise.withResolvers();
  registry.command("core.fixture.activate", async () => {
    schedule();
    await page.presented();
    completed.resolve();
    return null;
  });
  bind(document.getElementById("projectTab"), "core.fixture.activate");
  document.getElementById("projectTab").click();
  await completed.promise;
  await flushEvents();
  assert.deepEqual(linesOf(firstWire), [`error workbench workbench: surface presentation failed: ${TIMEOUT}`],
    "one layout failure of a project switch must write exactly the line of the layout queue that shows it");
  firstWire.finish();
});

test("a layout failure that no command waits for writes one workbench error line", async () => {
  const wire = selectPageWire("layout-failure-lines-gesture");
  reportRejectionsAsPage();
  // The same line is not written again, so the earlier presentation is withdrawn.
  hideError(banner, "workbench");
  schedule();
  assert.equal(await page.presented(), false, "a failed layout was reported as presented");
  await flushEvents();
  assert.deepEqual(linesOf(wire), [`error workbench workbench: surface presentation failed: ${TIMEOUT}`],
    "one layout failure of a gesture must write exactly the line of the layout queue that shows it");
  wire.finish();
});

test("a successful presentation reports completion", async () => {
  const wire = selectPageWire("layout-failure-lines-presented");
  const page = createPageLayout({
    document, showError, setVerify: () => {}, log: () => {}, surfaces,
    plane: {}, compositor: {}, textSize: () => 1, rendered: async () => {},
    waitSurfaceCompositionAnswered: async () => {},
  });
  assert.equal(await page.presented(), true);
  wire.finish();
});

// The host asks it before it waits for the presentation of the window (workbench.placement.last).
test("the last placement answers after the layout that waited behind the running layout", async () => {
  const wire = selectPageWire("layout-failure-lines-placement-last");
  const opened = [];
  // begun[i] resolves when the preparation of the i-th layout starts.
  const begun = (index) => (begins[index] ??= Promise.withResolvers()).promise;
  const begins = [];
  // Stand-in: the test holds each preparation of the compositor open and settles it at the step that the assertions name.
  const page = createPageLayout({
    document, showError, setVerify: () => {}, log: () => {}, surfaces,
    plane: {}, compositor: {
      publishAhead: () => new Promise((resolve, reject) => {
        opened.push({ resolve, reject });
        (begins[opened.length - 1] ??= Promise.withResolvers()).resolve();
      }),
      cancelPrepared: async () => {},
    }, textSize: () => 1, rendered: async () => {},
    waitSurfaceCompositionAnswered: async () => {},
  });
  const layout = () => page.onLayout(new Map(), () => {}, new Map(), 40, () => true);
  layout();
  await begun(0);
  layout();
  // The wait ends after the layout that waited behind the running layout, not with the running one. The running layout has ended
  // when the waiting one starts its preparation, and a wait that followed the running layout answers in the microtasks of that end,
  // so after the end of the microtask queue such a wait has answered.
  let answered = false;
  const wait = placementLast().then((answer) => { answered = true; return answer; });
  opened[0].resolve({});
  await begun(1);
  assert.equal(opened.length, 2, "the waiting layout did not start after the running layout");
  await drained();
  assert.equal(answered, false, "the wait ended with the layout that ran when the next one arrived");
  opened[1].resolve({});
  assert.equal(await wait, null);

  layout();
  const failed = placementLast();
  await begun(2);
  opened[2].reject(new Error(TIMEOUT));
  await assert.rejects(failed, (error) => error.message === TIMEOUT);
  wire.finish();
});
