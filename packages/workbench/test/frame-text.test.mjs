// 페이지가 준비에 담는 첫 행의 높이는 app.css 의 --chrome-row 와 같은 값이어야 한다(docs/spec/native-surfaces.md#title-bar-height).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { TEXT_STEPS } from "../text-size.js";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

/** app.css 에서 name 의 선언 값을 하나만 찾는다. 없거나 둘 이상이면 실패한다. */
function declared(name) {
  const found = [...css.matchAll(new RegExp(`${name}:([^;}]+)[;}]`, "g"))].map((m) => m[1].trim());
  assert.equal(found.length, 1, `app.css declares ${name} ${found.length} times`);
  return found[0];
}

/** --chrome-row 의 식을 CSS 의미대로 계산한다. round(nearest, x, 1px) 는 가운데 값에서 큰 쪽을 고른다. */
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
  // 쓰기 전에는 app.css 의 :root 값 1 이다.
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
