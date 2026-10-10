// Checks that an error shown on screen is written to the application log at that moment.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { recordsOf, settled, shownRecord } from "./support/records.mjs";

const lines = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => { for (const record of recordsOf(name, payload)) lines.push(shownRecord(record)); },
} } });
const { JSDOM } = await import("jsdom");
const { document } = new JSDOM("<p></p>").window;
const { hideError, showError } = await import("../shown-errors.js");

test("an error shown on the screen is logged once until it changes or clears", async () => {
  const el = document.querySelector("p");
  showError(el, "library", "folder is missing");
  assert.equal(el.textContent, "folder is missing");
  assert.equal(el.dataset.error, "library", "the shown error carries the attribute that the error color selects");
  showError(el, "library", "folder is missing");
  showError(el, "library", "registry failed");
  hideError(el, "library");
  assert.equal(el.dataset.error, undefined);
  showError(el, "library", "registry failed");
  await settled();
  assert.deepEqual(lines.splice(0), [
    "error page library: folder is missing", "error page library: registry failed", "error page library: registry failed",
  ]);
});
