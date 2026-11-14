// The document of the debug view tests: the modal view reads the colors of its card, which the style sheet of the document gives it, and the
// plane is the element that the view positions against. The tests select the page-wire case of the test before they call openDebugView, because
// the modules of the view read the host when they are imported (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../../exposure.json" with { type: "json" };

let exposureInstalled = false;

/**
 * Selects the case of the name, installs the document and opens the debug view over it. close ends the view and waits for the ordered calls of
 * the view and for the batch of the records of the page. The test calls wire.finish after close, which checks that every step of the case was played.
 */
export async function openDebugView(name, { entries } = {}) {
  const wire = selectPageWire(name);
  if (!exposureInstalled) {
    const { installExposure } = await import("../../exposure.js");
    installExposure(exposureFile);
    exposureInstalled = true;
  }
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
  const ui = await import(`../../debug-ui.js?view-${Math.random()}`);
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0 });
  // The ordered calls of the modal view end before the test judges the view or delivers the next host event.
  const calls = async () => { await orderedCallsAnswered(); };
  if (entries !== undefined) {
    assert.equal(typeof ui.setDebugFixtureEntries, "function", "diagnostic debug list input is missing");
    ui.setDebugFixtureEntries(entries);
  }
  await ui.openDebug();
  await calls();
  const close = async () => {
    ui.closeDebug();
    await calls();
    await flushEvents();
    dom.window.close();
  };
  return { ui, wire, calls, flushEvents, close };
}
