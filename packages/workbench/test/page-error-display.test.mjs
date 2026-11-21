// Checks the location detail that the page error display writes for an error event of the window (page-layout.js reportUncaught).
// An error event without a source location has no location, so the detail of its log line adds none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The page reads the host when it imports the page modules, so the case is selected before the import. The display sends no call.
const wire = selectPageWire("error-toasts");
const { createErrorDisplay, dismissErrorToast, reportUncaught } = await import("../page-layout.js");
const { registry } = await import("../exposure.js");
registry.declare("core", { status: [], element: [], commands: [{
  name: "core.error.dismiss", description: "Closes a toast.", params: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, result: { type: "null" },
}] });

const dom = new JSDOM("<body></body>");

/** A window that records each error the display shows, with the detail it writes to the log. */
function displayed() {
  const shown = [];
  reportUncaught(dom.window, (reason, detail) => shown.push({ reason, detail }));
  return shown;
}

// Each error of the workbench shows a toast at the bottom of the window, several at once, and the close control dismisses
// one alone (docs/spec/exposure.md, core.workbench.error). The shown records go through the error display, which the case
// of this file pins as no call, so the toasts of this test withdraw before the wire ends.
test("the errors of the workbench show as toasts and each closes on its own", () => {
  const show = createErrorDisplay({ document: dom.window.document, changed: () => {} });
  dom.window.document.getElementById("errorToasts")?.remove();
  show("first failure");
  show("second failure");
  const toasts = dom.window.document.getElementById("errorToasts")?.children;
  assert.equal(toasts?.length, 2, "two errors hold two toasts");
  assert.equal(toasts[0].dataset.text, "first failure");
  assert.equal(toasts[1].dataset.text, "second failure");
  assert.ok(toasts[1].querySelector('[data-expose="core.error.dismiss"]'), "each toast holds a close control");
  show("first failure");
  assert.equal(dom.window.document.getElementById("errorToasts").children.length, 2, "a repeated text adds no toast");
  assert.equal(dismissErrorToast(dom.window.document, "first failure"), true);
  const open = dom.window.document.getElementById("errorToasts").children;
  assert.equal(open.length, 1);
  assert.equal(open[0].dataset.text, "second failure");
  assert.equal(dismissErrorToast(dom.window.document, "first failure"), false, "a closed toast is not open");
  for (const toast of [...dom.window.document.getElementById("errorToasts").children]) toast.remove();
  wire.finish();
});

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

