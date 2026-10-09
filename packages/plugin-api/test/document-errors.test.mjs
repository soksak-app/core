// The errors and unhandled rejections of the document of a surface are written to the application log
// (docs/spec/diagnostics.md#forms).
import assert from "node:assert/strict";
import test from "node:test";
import { installDocumentErrors } from "../document-errors.js";

/** A target that keeps its listeners, so a test dispatches an event to them. */
function target() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    dispatch: (type, event) => listeners.get(type)(event),
    types: () => [...listeners.keys()].sort(),
  };
}

test("a script error, a resource that does not load and an unhandled rejection are reported once each", () => {
  const events = target();
  const lines = [];
  installDocumentErrors({ target: events, report: (line) => lines.push(line) });
  assert.deepEqual(events.types(), ["error", "unhandledrejection"]);
  events.dispatch("error", { message: "x is not defined", filename: "https://app/modules/p/ui.js", lineno: 7 });
  events.dispatch("error", { message: "x is not defined", filename: "https://app/modules/p/ui.js", lineno: 7 });
  events.dispatch("error", { target: { src: "https://app/modules/p/missing.js" } });
  events.dispatch("unhandledrejection", { reason: new Error("send refused") });
  events.dispatch("unhandledrejection", { reason: "plain text" });
  assert.deepEqual(lines, [
    "x is not defined @ https://app/modules/p/ui.js:7",
    "cannot load https://app/modules/p/missing.js",
    "send refused",
    "plain text",
  ]);
});
