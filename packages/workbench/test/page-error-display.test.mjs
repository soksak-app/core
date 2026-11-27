// Checks the location detail that the page error display writes for an error event of the window (page-layout.js reportUncaught).
// An error event without a source location has no location, so the detail of its log line adds none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The page reads the host when it imports the page modules, so the case is selected before the import.
const wire = selectPageWire("error-toasts");
const { flushEvents } = await import("../page-log.js");
const { reportUncaught } = await import("../page-layout.js");
const { errorToasts } = await import("../shown-errors.js");
const { notificationStore } = await import("../tab-reports.js");
const { registry } = await import("../exposure.js");
// The notice commands of the declaration, which the toasts bind.
const declared = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes;
registry.declare("core", { status: [], element: [], commands: declared.commands.filter(({ name }) => name.startsWith("core.notices.")) });

const dom = new JSDOM("<body></body>");

/** A window that records each error the display shows, with the detail it writes to the log. */
function displayed() {
  const shown = [];
  reportUncaught(dom.window, (reason, detail) => shown.push({ reason, detail }));
  return shown;
}

// Each error of the workbench shows a toast at the bottom of the window, several at once, and the close control dismisses
// one alone (docs/spec/notifications.md#toasts). The records of toasts that have closed still reach the host.
test("the errors of the workbench show as toasts and each closes on its own", async () => {
  // The notice store is one per page: the notices of earlier steps of the file do not count.
  notificationStore().clearAll();
  const { show, dismiss } = errorToasts(dom.window.document);
  show("first failure");
  show("second failure");
  const document = dom.window.document;
  const titles = () => [...document.querySelectorAll("#toasts > .toast .toast__title")].map((title) => title.textContent);
  assert.deepEqual(titles(), ["second failure", "first failure"], "the newest toast is first (docs/spec/notifications.md#toasts)");
  assert.ok(document.querySelector("#toasts > .toast")?.querySelector('[data-expose="core.notices.close"]'), "each toast holds a close control");
  // A redraw of a shown error with the same text is the same occurrence: no toast, no count and no log line.
  show("first failure");
  assert.deepEqual(titles(), ["second failure", "first failure"], "a repeated text adds no toast");
  assert.equal(dismiss("first failure"), true);
  assert.deepEqual(titles(), ["second failure"]);
  assert.equal(dismiss("first failure"), false, "a closed toast is not open");
  assert.equal(dismiss("second failure"), true);
  await flushEvents();
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

