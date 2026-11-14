// The chrome metrics of workbench.json that the workbench applies by script: a media condition cannot read a custom property, and the focus
// mark stands outside its slot by the thickness of its stroke (docs/spec/settings.md#values).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import { backgroundBlurRule, CHROME, focusMarkBox, libraryNarrowCondition, markLibraryNarrow } from "../chrome-metrics.js";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const declared = () => JSON.parse(read("workbench.json")).chrome;

/** Runs body while the chrome metric name holds value, and restores the declared value afterwards. */
function withMetric(name, value, body) {
  const kept = CHROME[name];
  CHROME[name] = value;
  try { body(); } finally { CHROME[name] = kept; }
}

test("the library is marked narrow while the window is at most the chrome metric library-narrow-w wide", () => {
  assert.equal(CHROME["library-narrow-w"], declared()["library-narrow-w"]);
  assert.equal(libraryNarrowCondition(), `(max-width: ${declared()["library-narrow-w"]})`);
  const root = new JSDOM("").window.document.documentElement;
  assert.equal(root.hasAttribute("data-library-narrow"), false);
  markLibraryNarrow(root, true);
  assert.equal(root.getAttribute("data-library-narrow"), "");
  markLibraryNarrow(root, false);
  assert.equal(root.hasAttribute("data-library-narrow"), false);

  // The width is read from the metric when the page follows it.
  withMetric("library-narrow-w", "512px", () => {
    assert.equal(libraryNarrowCondition(), "(max-width: 512px)");
  });

  // library.css narrows by the mark and holds no width condition of its own.
  const css = read("library.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /:root\[data-library-narrow\] \.library-grid\{/);
  assert.doesNotMatch(css, /@media[^{]*width/);
});

test("the focus mark surrounds the slot, outside it on every side by the chrome metric focus-mark-t", () => {
  const thickness = declared()["focus-mark-t"];
  assert.equal(CHROME["focus-mark-t"], thickness);
  assert.match(thickness, /^\d+(\.\d+)?px$/);
  const host = { left: 100, top: 40, width: 900, height: 700 };
  const slot = { left: 310, top: 155, width: 400, height: 250 };
  const placed = () => focusMarkBox(host, slot);
  const out = parseFloat(thickness);
  assert.ok(out > 0);
  assert.deepEqual(placed(), { left: `${210 - out}px`, top: `${115 - out}px`, width: `${400 + out * 2}px`, height: `${250 + out * 2}px` });

  // The outset is read from the metric when the mark is placed.
  withMetric("focus-mark-t", "3px", () => {
    assert.deepEqual(placed(), { left: "207px", top: "112px", width: "406px", height: "256px" });
  });

  // The stroke of the mark is the same metric thick, so the outset keeps the stroke outside the slot.
  const rule = read("app.css").match(/\.focus-mark\{([^}]*)\}/)[1];
  const size = rule.match(/background-size:([^;}]*)/)[1];
  assert.deepEqual([...new Set(size.match(/var\(--[\w-]+\)/g))].sort(), ["var(--focus-mark-len)", "var(--focus-mark-t)"]);
  assert.equal(size.replace(/var\(--[\w-]+\)|[\s,]/g, ""), "");
});

test("the background blur of each web document is the chrome metric scrim-blur", () => {
  assert.ok(read("background.js").includes(backgroundBlurRule));
});
