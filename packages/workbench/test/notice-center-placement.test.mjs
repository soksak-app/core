// The notice center and the toasts stand below the drawn title bar row, which grows with the frame text factor, so the row never covers
// them and they never cover the bell (docs/spec/notifications.md#notice-center, docs/spec/native-surfaces.md#title-bar-height). The rules of
// app.css are applied to a document, and the placement that reaches each element is read from it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const dom = new JSDOM(`<style>${css}</style><header class="chrome-bar"></header><div id="toasts"></div><section class="notice-center"></section><section class="notice-center" data-style="drawer"></section>`);
const style = (selector, index = 0) => dom.window.getComputedStyle(dom.window.document.querySelectorAll(selector)[index]);

test("the title bar row height is a value of the root, which every element below the bar reads", () => {
  assert.match(style("html").getPropertyValue("--chrome-row"), /var\(--chrome-row-h\)\s*\*\s*var\(--frame-text\)/,
    "the root does not hold the scaled height of the title bar row");
  assert.equal(style(".chrome-bar").height, "var(--chrome-row)");
});

test("the popover, the drawer and the toasts start below the drawn title bar row", () => {
  assert.equal(style(".notice-center", 0).top, "var(--chrome-row)", "the popover starts at the unscaled title bar height");
  assert.equal(style(".notice-center", 1).top, "var(--chrome-row)", "the drawer starts at the unscaled title bar height");
  assert.match(style("#toasts").top, /var\(--chrome-row\)/, "the toasts start at a fixed distance from the top of the window");
});
