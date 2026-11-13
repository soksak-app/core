// Checks that an error shown on screen is written to the application log at that moment.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

// The case selects the host of the page before the modules below are imported, because the page reads the host when it is imported.
const wire = selectPageWire("shown-errors-record");
const { JSDOM } = await import("jsdom");
const { document } = new JSDOM("<p></p>").window;
const { hideError, showError } = await import("../shown-errors.js");
const { flushEvents } = await import("../page-log.js");

test("an error shown on the screen is logged once until it changes or clears", { timeout: 5000 }, async () => {
  const el = document.querySelector("p");
  showError(el, "library", "folder is missing");
  assert.equal(el.textContent, "folder is missing");
  assert.equal(el.dataset.error, "library", "the shown error carries the attribute that the error color selects");
  showError(el, "library", "folder is missing");
  showError(el, "library", "registry failed");
  hideError(el, "library");
  assert.equal(el.dataset.error, undefined);
  showError(el, "library", "registry failed");
  await flushEvents();
  assert.deepEqual(wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload)).map(shownRecord), [
    "error workbench library: folder is missing", "error workbench library: registry failed", "error workbench library: registry failed",
  ]);
  wire.finish();
});
