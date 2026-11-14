// An error that stops the main page from starting is written to the application log when it occurs (docs/spec/native-host.md#page-start).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import { installPageStartErrors } from "../page-start-errors.js";

/** A document window with its own listeners, and the lines that the handler of the start writes. */
function fixture(t) {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  t.after(() => dom.window.close());
  const target = dom.window;
  const lines = [];
  const start = installPageStartErrors({ target, report: (line) => lines.push(line) });
  return { dom, target, lines, start };
}

const error = (target, message, filename, lineno) => target.dispatchEvent(new target.ErrorEvent("error", { message, filename, lineno }));
const rejection = (target, reason) => target.dispatchEvent(Object.assign(new target.Event("unhandledrejection"), { reason }));

test("an error before the first screen is written as a page start error with its file and line", (t) => {
  const { target, lines } = fixture(t);
  error(target, "boom", "/debug-ui.js", 12);
  assert.deepEqual(lines, ["start: boom @ /debug-ui.js:12"]);
});

test("a rejection before the first screen is written with its message", (t) => {
  const { target, lines } = fixture(t);
  rejection(target, new Error("denied"));
  rejection(target, "plain");
  assert.deepEqual(lines, ["start: denied", "start: plain"]);
});

test("the same cause is written once", (t) => {
  const { target, lines } = fixture(t);
  for (let count = 0; count < 3; count += 1) error(target, "boom", "/a.js", 1);
  assert.equal(lines.length, 1);
});

test("a module that fails to load is written with its address", (t) => {
  const { dom, lines } = fixture(t);
  const script = dom.window.document.createElement("script");
  script.type = "module";
  script.src = "http://127.0.0.1/missing.js";
  dom.window.document.body.append(script);
  script.dispatchEvent(new dom.window.Event("error"));
  assert.deepEqual(lines, ["start: cannot load http://127.0.0.1/missing.js"]);
});

test("nothing is written after the page has drawn its first screen", (t) => {
  const { target, lines, start } = fixture(t);
  start.finish();
  error(target, "late", "/a.js", 1);
  rejection(target, "late");
  assert.deepEqual(lines, [], "a handler of the start remains");
  start.finish();
});

test("the first module of the start document installs the handler", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const imports = [...html.matchAll(/^import [^\n]*from "([^"]+)"/gm)].map((match) => match[1]);
  assert.equal(imports[0], "./page-start-errors-install.js");
});

test("the settings listener is connected before a command can change a setting", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf("onSettingsChange(() => {") < html.indexOf("installCoreExposure({"),
    "a setting that core.settings.set changes before the listener is connected is not drawn");
});
