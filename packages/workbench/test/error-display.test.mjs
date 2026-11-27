// An error that the user sees appears only through one display path (shown-errors.js), and the error color is used only for the data-error element that
// this path attaches and the notice elements of the notification path (the bell, toasts, status line and center; docs/spec/notifications.md#decisions)
// (AGENTS.md). This test looks for places in the stylesheet and the sources that violate that rule.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const here = new URL("../", import.meta.url);
const files = (extension) => readdirSync(here).filter((name) => name.endsWith(extension));
// The error color in a place that is not an error. The hover of the tab close button only emphasizes the action of closing and shows no error.
const NOT_ERRORS = new Set([".tab__x:hover"]);
// The notice elements of the notification path, which may use the error color: the bell, the toasts, the status line and the center.
const NOTICE_PATH = /#toasts|\.toast|\.notice-/;

test("the error color is used only by the elements of the error display path", () => {
  const offending = [];
  for (const name of files(".css")) {
    const text = readFileSync(new URL(name, here), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      if (!match[2].includes("var(--no)")) continue;
      if (selector.split(",").every((part) => part.includes("[data-error]") || NOT_ERRORS.has(part.trim()) || NOTICE_PATH.test(part))) continue;
      offending.push(`${name}: ${selector}`);
    }
  }
  assert.deepEqual(offending, [], "these rules color an error outside the error display path");
});

test("only the error display path marks an element as an error", () => {
  const offending = [];
  for (const name of [...files(".js"), ...files(".html")]) {
    if (name === "shown-errors.js") continue;
    const text = readFileSync(new URL(name, here), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/dataset\.error\b|["']data-error["']|\[data-error\]/.test(line)) offending.push(`${name}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offending, [], "these lines mark an error without the error display path");
});

test("the toast stack floats under the bell at the right of the window and of a dialog", () => {
  const dom = new JSDOM("<head></head>");
  try {
    const sheet = dom.window.document.createElement("style");
    sheet.textContent = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    dom.window.document.head.append(sheet);
    const style = (selector) => [...sheet.sheet.cssRules].find((rule) => rule.selectorText === selector)?.style;
    const holder = style("#toasts");
    assert.equal(holder.position, "fixed");
    // The stack keeps the distance of toast-top from the drawn title bar row, which grows with the frame text factor.
    assert.equal(holder.top, "calc(var(--chrome-row) + var(--toast-top) - var(--chrome-h))");
    assert.equal(holder.right, "var(--toast-right)");
    assert.equal(holder.getPropertyValue("pointer-events"), "none");
    assert.equal(style('[data-native-modal="dialog"] > #toasts').position, "absolute");
    const card = style(".toast");
    assert.equal(card.background, "var(--card)");
    assert.equal(card.getPropertyValue("border-radius"), "var(--r-sm)");
    assert.equal(card.getPropertyValue("pointer-events"), "auto");
  } finally {
    dom.window.close();
  }
});
