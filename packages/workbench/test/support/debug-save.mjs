// Shared helpers of the save tests of the debug view (docs/spec/debug.md#files). Each test file of debug-save-ui-*.test.mjs runs in its own
// process, so the first log batch of that process takes the clock calls of its case. The modules that read the host are imported after the
// case of the test is selected, so openSaveView imports them dynamically.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../../exposure.json" with { type: "json" };

let exposureInstalled = false;

/** Selects the case of the name, opens the debug view over a new document and returns the view, its wire and the ordered-call helpers. */
export async function openSaveView(name, fixtureEntries) {
  const wire = selectPageWire(name);
  if (!exposureInstalled) {
    const { installExposure } = await import("../../exposure.js");
    installExposure(exposureFile);
    exposureInstalled = true;
  }
  // The modal view reads the colors of its element, which the style sheet of the document gives it.
  const dom = new JSDOM("<head><style>.dbg-card { border-top-color: rgb(7, 8, 9); background-color: rgb(255, 255, 255); }</style></head>"
    + "<body><div id=plane></div></body>");
  globalThis.document = dom.window.document;
  // JSDOM has no adopted style sheets; the document holds none.
  Object.defineProperty(document, "adoptedStyleSheets", { value: [] });
  globalThis.CSS = { escape: (value) => value };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.innerWidth = dom.window.innerWidth;
  globalThis.innerHeight = dom.window.innerHeight;
  const { orderedCallsAnswered } = await import("../../host.js");
  const { flushEvents } = await import("../../page-log.js");
  const ui = await import(`../../debug-ui.js?save-${Math.random()}`);
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0 });
  // The ordered calls of the modal view end before the test judges the view or delivers the next host event.
  const calls = async () => { await orderedCallsAnswered(); };
  const close = async () => {
    ui.closeDebug();
    await calls();
    dom.window.close();
  };
  if (fixtureEntries !== undefined) {
    assert.equal(typeof ui.setDebugFixtureEntries, "function", "diagnostic debug list input is missing");
    ui.setDebugFixtureEntries(fixtureEntries);
  }
  await ui.openDebug();
  await calls();
  return { ui, wire, calls, flushEvents, close };
}

export const progressBar = () => document.querySelector('[data-expose="core.debug.progress"]');
export const saveButton = () => document.querySelector('[data-key="save-all"]');
