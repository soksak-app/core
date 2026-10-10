// The height of the first row that the page puts in a preparation must equal --chrome-row of app.css (docs/spec/native-surfaces.md#title-bar-height).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { TEXT_STEPS } from "../text-size.js";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

/** Finds exactly one declared value of name in app.css. It fails when there is none or more than one. */
function declared(name) {
  const found = [...css.matchAll(new RegExp(`${name}:([^;}]+)[;}]`, "g"))].map((m) => m[1].trim());
  assert.equal(found.length, 1, `app.css declares ${name} ${found.length} times`);
  return found[0];
}

/** Computes the expression of chrome-row with CSS semantics. round(nearest, x, 1px) picks the larger side at the middle value. */
function cssRow(factor) {
  const expression = declared("--chrome-row");
  assert.equal(expression, "round(nearest,max(var(--chrome-h),calc(var(--chrome-row-h) * var(--frame-text))),1px)",
    "the --chrome-row expression changed; chromeRow must follow it");
  const px = (value) => {
    const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
    assert.ok(match, `${value} is not a px length`);
    return Number(match[1]);
  };
  const scaled = px(declared("--chrome-row-h")) * factor;
  return Math.floor(Math.max(px(declared("--chrome-h")), scaled) + 0.5);
}

test("the first-row height that the page prepares equals the --chrome-row of app.css at every frame factor", async () => {
  const { chromeRow } = await import("../frame-text.js");
  for (const factor of TEXT_STEPS) {
    assert.equal(chromeRow(factor), cssRow(factor), `factor ${factor}`);
  }
  assert.deepEqual([1, 1.25, 1.5, 3].map(chromeRow), [40, 45, 54, 108]);
  for (const invalid of [0, -1, Number.NaN, Infinity, "1.5", null]) {
    assert.throws(() => chromeRow(invalid), /frame text factor .* is not a positive finite number/, String(invalid));
  }
});

test("a factor is written into the document only by a draw, and a measurement restores the drawn factor", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.document = dom.window.document;
  t.after(() => { delete globalThis.document; dom.window.close(); });
  const { applyFrameText, drawnFrameText, measureAt } = await import("../frame-text.js?test=apply");
  const root = dom.window.document.documentElement;
  // Before it is written, the value is 1, the :root value of app.css.
  assert.equal(drawnFrameText(), 1);
  applyFrameText(1.5);
  assert.equal(drawnFrameText(), 1.5);
  assert.equal(root.style.getPropertyValue("--frame-text"), "1.5");
  assert.equal(root.dataset.frameText, "");
  const during = measureAt(2, () => [root.style.getPropertyValue("--frame-text"), root.dataset.frameText]);
  assert.deepEqual(during, ["2", ""], "the measurement reads the document at the measured factor");
  assert.equal(root.style.getPropertyValue("--frame-text"), "1.5", "the measurement restores the drawn factor");
  assert.equal(drawnFrameText(), 1.5);
  assert.throws(() => measureAt(3, () => { throw new Error("injected read failure"); }), /injected read failure/);
  assert.equal(root.style.getPropertyValue("--frame-text"), "1.5", "a failed measurement restores the drawn factor");
  applyFrameText(1);
  assert.equal(root.dataset.frameText, undefined, "factor 1 declares no zoom");
});

// A scale change in a window without a plane and the switch to the library are drawn with the prepared layout. The switch cancels the drawing of
// the layout prepared before it, so the drawing of the switch must use the current scale, or the scale of the canceled drawing is lost. The library
// screen clears the plane in the same drawing and then draws (F43).
test("a frame layout prepares the row of its factor and writes the factor and shows the screen after clearing the plane", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.document = dom.window.document;
  t.after(() => { delete globalThis.document; dom.window.close(); });
  const { drawnFrameText, frameLayout } = await import("../frame-text.js?test=layout");
  const { drawPrepared } = await import("../layout-queue.js");
  const calls = [];
  const layout = frameLayout({
    factor: 1.5,
    publishAhead: (rects, seated, titlebar) => {
      calls.push(["prepare", rects.size, seated.size, titlebar, drawnFrameText()]);
      return Promise.resolve([]);
    },
    publish: () => { calls.push(["publish", drawnFrameText()]); return Promise.resolve([]); },
    frame: (work) => { work(); return Promise.resolve(); },
    clearPlane: () => calls.push(["clear", drawnFrameText()]),
    show: () => calls.push(["show", drawnFrameText()]),
  });
  await drawPrepared({ epoch: 0, current: () => 0, ...layout });
  assert.deepEqual(calls, [["prepare", 0, 0, 54, 1], ["clear", 1], ["show", 1.5], ["publish", 1.5]]);
  assert.equal(document.documentElement.style.getPropertyValue("--frame-text"), "1.5");
});
