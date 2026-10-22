// Checks the location detail that the page error display writes for an error event of the window (page-layout.js reportUncaught).
// An error event without a source location has no location, so the detail of its log line adds none.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>");
// The lines of the display path are collected through the host report function (shown-errors.js).
mock.module("../host.js", { namedExports: { report: () => {} } });
const { reportUncaught } = await import("../page-layout.js");

/** A window that records each error the display shows, with the detail it writes to the log. */
function displayed() {
  const shown = [];
  reportUncaught(dom.window, (reason, detail) => shown.push({ reason, detail }));
  return shown;
}

test("an error event without a source location writes no location detail", () => {
  const shown = displayed();
  dom.window.dispatchEvent(new dom.window.ErrorEvent("error", { message: "demo.lines: snapshot store read failed" }));
  assert.deepEqual(shown, [{ reason: "demo.lines: snapshot store read failed", detail: "" }], "the detail invents a location");
});

test("an error event with a source location writes its location as the detail", () => {
  const shown = displayed();
  dom.window.dispatchEvent(new dom.window.ErrorEvent("error", { message: "failed", filename: "app.js", lineno: 7 }));
  assert.deepEqual(shown, [{ reason: "failed", detail: " @ app.js:7" }], "the location of the error was not written");
});
