import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../browser/background.js", import.meta.url), "utf8");
for (const early of [true, false]) {
  test(`background state delivered ${early ? "before" : "after"} script initialization applies and clears blur`, () => {
    const original = {};
    const document = { adoptedStyleSheets: [original] };
    const window = early ? { __soksakBackground: true } : {};
    class CSSStyleSheet { replaceSync(css) { this.css = css; } }
    runInNewContext(source, { window, document, CSSStyleSheet });
    if (!early) window.__soksakBackground = true;
    assert.equal(document.adoptedStyleSheets.length, 2);
    assert.equal(document.adoptedStyleSheets[0], original);
    assert.match(document.adoptedStyleSheets[1].css, /filter: blur\(3px\)/);
    window.__soksakBackground = true;
    assert.equal(document.adoptedStyleSheets.length, 2, "repeated state must not duplicate the stylesheet");
    window.__soksakBackground = false;
    assert.deepEqual(Array.from(document.adoptedStyleSheets), [original]);
  });
}
