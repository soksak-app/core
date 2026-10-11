// Checks the lines that the failure of one layout writes to the application log. The failed callback of the layout queue receives and shows that failure, so neither the project switch command
// that waited for the layout nor the gesture that scheduled the layout writes the same failure again (docs/spec/hosts.md#application-log).
// The connections are the error display of page-layout.js that index.html uses, the report of unhandled rejections, the layout receiver, and the
// presented callback of the project switch; this test fakes only the host bridge, the compositor, and the window events.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { clockAnswer, recordsOf, settled, shownRecord } from "./support/records.mjs";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

const dom = new JSDOM('<div id="applicationError"></div><button id="projectTab"></button>');
globalThis.document = dom.window.document;
const lines = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, request) => {
    if (name === "log") { if (clockAnswer(name, request)) return clockAnswer(name, request); for (const record of recordsOf(name, request)) lines.push(shownRecord(record)); return; }
    throw new Error(`unexpected host call ${name}`);
  },
} } });
const { report, surfaces } = await import("../host.js");
const { createErrorDisplay, createPageLayout, reportUncaught } = await import("../page-layout.js");
const { hideError } = await import("../shown-errors.js");
const { connectExposure, registry } = await import("../exposure.js");
const { bind } = await import("../commands.js");

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

const page = createPageLayout({
  document, showError, setVerify: () => {}, log: () => {}, surfaces,
  plane: {},
  compositor: { publishAhead: () => Promise.reject(new Error(TIMEOUT)) },
  textSize: () => 1,
  rendered: () => Promise.resolve(),
  waitSurfaceCompositionDeclared: async () => {},
});
await connectExposure({ settled: page.drawn, report });
/** The plane schedules a layout. The preparation of that layout fails. */
const schedule = () => { page.onLayout(new Map(), () => {}, new Map(), 40); };

/** Finishes all microtasks and the reporting of unhandled rejections up to the next macrotask. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a layout failure of a project switch started from the interface writes one page error line", async () => {
  reportRejectionsAsPage();
  lines.length = 0;
  registry.declare("core", { status: [], dom: [], commands: [{
    name: "core.fixture.activate", description: "Activates.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] });
  // A project switch schedules the loaded layout on the plane, waits for its presentation, and then replies (showProject of projects.js).
  registry.command("core.fixture.activate", async () => {
    schedule();
    await page.presented();
    return null;
  });
  bind(document.getElementById("projectTab"), "core.fixture.activate");
  document.getElementById("projectTab").click();
  await settle();
  await settle();
  assert.deepEqual(lines, [`error page page: surface presentation failed: ${TIMEOUT}`],
    "one layout failure of a project switch must write exactly the line of the layout queue that shows it");
});

test("a layout failure that no command waits for writes one page error line", async () => {
  reportRejectionsAsPage();
  // The same line is not written again, so the earlier presentation is withdrawn.
  hideError(banner, "page");
  lines.length = 0;
  schedule();
  await settle();
  await settle();
  assert.deepEqual(lines, [`error page page: surface presentation failed: ${TIMEOUT}`],
    "one layout failure of a gesture must write exactly the line of the layout queue that shows it");
});
