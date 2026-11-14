// The save of the logs folder in the debug view (docs/spec/debug.md): the host answers when the person chose the place and
// writes the tar on its own thread; the view shows the progress that the host reports, shows the button disabled, and
// refuses a second save while one writes. The host calls and the host events of each test are the page-wire case of the test
// (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

let exposureInstalled = false;

// The modules that read the host are imported after the case of the test is selected. The host module is one module of the page, so the later
// tests answer through the case that they select.
async function openView(name, fixtureEntries) {
  const wire = selectPageWire(name);
  if (!exposureInstalled) {
    const { installExposure } = await import("../exposure.js");
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
  const { orderedCallsAnswered } = await import("../host.js");
  const { flushEvents } = await import("../page-log.js");
  const ui = await import(`../debug-ui.js?save-${Math.random()}`);
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

const progressBar = () => document.querySelector('[data-expose="core.debug.progress"]');
const saveButton = () => document.querySelector('[data-key="save-all"]');

test("a save shows the progress that the host reports, shows the button disabled, and ends with the done event", { timeout: 5000 }, async () => {
  const { ui, wire, calls, close } = await openView("debug-save-ui-progress");
  try {
    assert.deepEqual(await ui.saveDebugFiles(), { saved: "/d/soksak.tar.gz", total: 3000 });
    assert.deepEqual(ui.debugState().operation, { action: "save-all", path: "/d/soksak.tar.gz", state: "running", written: 0, total: 3000 });
    assert.equal(progressBar().closest(".dbg-card__progress").hidden, false, "the progress bar is hidden while the save runs");
    assert.equal(saveButton().disabled, true, "the button of the save is not disabled while the save runs");
    await calls();
    wire.deliverNotice();
    assert.equal(ui.debugState().operation.written, 1500);
    assert.equal(progressBar().value, 1500);
    assert.equal(progressBar().max, 3000);
    await calls();
    wire.deliverNotice();
    assert.deepEqual(ui.debugState().operation, { action: "save-all", path: "/d/soksak.tar.gz", state: "done", written: 3000, total: 3000 });
    assert.equal(progressBar().closest(".dbg-card__progress").hidden, true);
    assert.equal(saveButton().disabled, false);
  } finally {
    await close();
  }
  wire.finish();
});

test("a save while one writes is refused and shown, and a failure of the write is shown", { timeout: 5000 }, async () => {
  const { ui, wire, calls, flushEvents, close } = await openView("debug-save-ui-refused");
  try {
    await ui.saveDebugFiles();
    await assert.rejects(ui.saveDebugFiles(), /debug: a save of the logs folder is running: \/d\/soksak\.tar\.gz/);
    assert.match(ui.debugState().error, /a save of the logs folder is running/);
    // The shown error is written to the application log in a batch, which leaves after the ordered calls of the view.
    await calls();
    await flushEvents();
    wire.deliverNotice();
    assert.equal(ui.debugState().operation.state, "failed");
    assert.match(ui.debugState().error, /disk full/);
    await calls();
    await flushEvents();
  } finally {
    await close();
  }
  wire.finish();
});

test("a cancelled save panel ends the operation without a progress bar", { timeout: 5000 }, async () => {
  const { ui, wire, close } = await openView("debug-save-ui-cancelled");
  try {
    assert.deepEqual(await ui.saveDebugFiles(), { saved: null, total: 0 });
    assert.deepEqual(ui.debugState().operation, { action: "save-all", path: null, state: "done" });
    assert.equal(progressBar().closest(".dbg-card__progress").hidden, true);
    assert.equal(saveButton().disabled, false);
  } finally {
    await close();
  }
  wire.finish();
});


test("a diagnostic debug fixture uses the existing list renderer and resets to live entries", { timeout: 5000 }, async () => {
  const entries = [
    { path: "logs/design/a.log", size: 12, modified: 2000 },
    { path: "logs/design/b.log", size: 3, modified: 1000 },
  ];
  const { ui, wire, calls, close } = await openView("debug-save-ui-fixture", entries);
  try {
    assert.deepEqual(ui.debugState().entries, entries);
    assert.equal(document.querySelectorAll('[data-expose="core.debug.file"]').length, 2,
      "the ordinary file list must render every declared entry");
    assert.equal(document.querySelectorAll('[data-expose="core.debug.save"]').length, 2,
      "fixture rows keep the existing action controls rather than a new layout");
    ui.closeDebug();
    ui.setDebugFixtureEntries(null);
    await ui.openDebug();
    await calls();
    assert.deepEqual(ui.debugState().entries, []);
    assert.equal(document.querySelectorAll('[data-expose="core.debug.file"]').length, 0);
  } finally {
    await close();
  }
  wire.finish();
});
