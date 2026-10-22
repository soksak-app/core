// Checks that the view start script reports a failure of the view page before its first call: a script that fails to load, an
// uncaught error and an unhandled rejection, each as one view.error message through the handler (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

/** Loads the start script into a page of the plugin fixture-plugin and returns the window and the messages the handler received. */
function startPage() {
  const dom = new JSDOM("", { url: "sok://fixture-plugin/ui/index.html", runScripts: "outside-only" });
  const posted = [];
  dom.window.webkit = { messageHandlers: { "sok-view": { postMessage: (message) => posted.push(structuredClone(message)) } } };
  dom.window.eval(readFileSync(new URL("../view-start.js", import.meta.url), "utf8"));
  return { window: dom.window, posted };
}

test("a script of the view page that fails to load is reported as one view.error that names the script", () => {
  const { window, posted } = startPage();
  const script = window.document.createElement("script");
  script.src = "sok://fixture-plugin/ui/view.js";
  window.document.head.appendChild(script);
  posted.splice(0);
  script.dispatchEvent(new window.Event("error"));
  assert.deepEqual(posted, [{ event: "view.error", plugin: "fixture-plugin", reason: "script sok://fixture-plugin/ui/view.js failed to load" }]);
});

test("an uncaught error of the view page is reported as one view.error with its message", () => {
  const { window, posted } = startPage();
  posted.splice(0);
  window.dispatchEvent(new window.ErrorEvent("error", { message: "boom" }));
  assert.deepEqual(posted, [{ event: "view.error", plugin: "fixture-plugin", reason: "uncaught error: boom" }]);
});

test("an unhandled rejection of the view page is reported as one view.error with its reason", () => {
  const { window, posted } = startPage();
  posted.splice(0);
  const event = new window.Event("unhandledrejection");
  event.reason = new window.Error("late");
  window.dispatchEvent(event);
  assert.deepEqual(posted, [{ event: "view.error", plugin: "fixture-plugin", reason: "unhandled rejection: late" }]);
});
