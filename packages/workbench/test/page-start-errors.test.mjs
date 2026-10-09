// An error that stops the main page from starting is written to the application log when it occurs (docs/spec/native-host.md#page-start).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { installPageStartErrors } from "../page-start-errors.js";

/** A window that keeps the listeners it was given, by type and capture flag, and delivers events to them. */
class FakeWindow {
  listeners = [];
  addEventListener(type, listener, options) {
    this.listeners.push({ type, listener, capture: options?.capture === true });
  }
  removeEventListener(type, listener, options) {
    const capture = options?.capture === true;
    this.listeners = this.listeners.filter((item) => !(item.type === type && item.listener === listener && item.capture === capture));
  }
  dispatchEvent(event) {
    for (const item of this.listeners.filter((entry) => entry.type === event.type)) item.listener(event);
  }
}

/** An event target that records the lines sent to the host. */
function fixture() {
  const target = new FakeWindow();
  const lines = [];
  const start = installPageStartErrors({ target, report: (line) => lines.push(line) });
  return { target, lines, start };
}

const error = (message, filename, lineno) => ({ type: "error", message, filename, lineno });
const rejection = (reason) => ({ type: "unhandledrejection", reason });

test("an error before the first screen is written as a page start error with its file and line", () => {
  const { target, lines } = fixture();
  target.dispatchEvent(error("boom", "/debug-ui.js", 12));
  assert.deepEqual(lines, ["start: boom @ /debug-ui.js:12"]);
});

test("a rejection before the first screen is written with its message", () => {
  const { target, lines } = fixture();
  target.dispatchEvent(rejection(new Error("denied")));
  target.dispatchEvent(rejection("plain"));
  assert.deepEqual(lines, ["start: denied", "start: plain"]);
});

test("the same cause is written once", () => {
  const { target, lines } = fixture();
  for (let count = 0; count < 3; count += 1) target.dispatchEvent(error("boom", "/a.js", 1));
  assert.equal(lines.length, 1);
});

test("a module that fails to load is written with its address", () => {
  const { target, lines } = fixture();
  const failed = { type: "error", target: { src: "http://127.0.0.1/missing.js" } };
  target.dispatchEvent(failed);
  assert.deepEqual(lines, ["start: cannot load http://127.0.0.1/missing.js"]);
});

test("nothing is written after the page has drawn its first screen", () => {
  const { target, lines, start } = fixture();
  start.finish();
  target.dispatchEvent(error("late", "/a.js", 1));
  assert.deepEqual(lines, []);
  assert.deepEqual(target.listeners, [], "a handler of the start remains");
  start.finish();
});

test("the first module of the start document installs the handler", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const imports = [...html.matchAll(/^import [^\n]*from "([^"]+)"/gm)].map((match) => match[1]);
  assert.equal(imports[0], "./page-start-errors-install.js");
});
