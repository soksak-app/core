// Checks that an error shown on screen is written to the application log at that moment.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

// The case selects the host of the page before the modules below are imported, because the page reads the host when it is imported.
const wire = selectPageWire("shown-errors-record");
const { JSDOM } = await import("jsdom");
const { window } = new JSDOM("<p></p>");
const { document } = window;
globalThis.window = window;
globalThis.document = document;
const { installExposure } = await import("../exposure.js");
const { default: exposureFile } = await import("../exposure.json", { with: { type: "json" } });
installExposure(exposureFile);
const { hideError, showError } = await import("../shown-errors.js");
const { flushEvents } = await import("../page-log.js");

test("an error shown on the screen opens a toast, is logged once until it changes or clears, and leaves its control unchanged", { timeout: 5000 }, async () => {
  const el = document.querySelector("p");
  el.textContent = "control label";
  const toast = () => document.querySelector(".error-toast__text")?.textContent ?? null;
  showError(document, "library", "folder is missing");
  assert.equal(toast(), "folder is missing");
  assert.equal(el.textContent, "control label", "the control keeps its label");
  assert.equal(el.dataset.error, undefined, "no element other than the toast text carries the error");
  showError(document, "library", "folder is missing");
  showError(document, "library", "registry failed");
  assert.equal(toast(), "registry failed");
  hideError(document, "library");
  assert.equal(toast(), null, "the withdrawal of the origin closes its toast");
  showError(document, "library", "registry failed");
  await flushEvents();
  assert.deepEqual(wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload)).map(shownRecord), [
    "error workbench library: folder is missing", "error workbench library: registry failed", "error workbench library: registry failed",
  ]);
  wire.finish();
});
