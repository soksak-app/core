// An error that the user sees appears only through one display path (shown-errors.js), and the error color is used only for the data-error element that
// this path attaches (AGENTS.md). This test looks for places in the stylesheet and the sources that violate that rule.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const here = new URL("../", import.meta.url);
const files = (extension) => readdirSync(here).filter((name) => name.endsWith(extension));
// The error color in a place that is not an error. The hover of the tab close button only emphasizes the action of closing and shows no error.
const NOT_ERRORS = new Set([".tab__x:hover"]);

test("the error color is used only by the elements of the error display path", () => {
  const offending = [];
  for (const name of files(".css")) {
    const text = readFileSync(new URL(name, here), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      if (!match[2].includes("var(--no)")) continue;
      if (selector.split(",").every((part) => part.includes("[data-error]") || NOT_ERRORS.has(part.trim()))) continue;
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
