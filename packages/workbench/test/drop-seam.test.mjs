import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

// The drop zone at the seam draws no radius and a border of the border width, as the cards at gap 0 (row gap of
// docs/spec/settings.md). The host draws the preview from the computed style of #drop (showDrop of plane.js), so the computed
// style is the drawn shape. jsdom does not compute var(), so the test writes the values that the page sets on the root (the
// chrome metrics of workbench.json and the tokens of each theme, themeTokens of settings.js) into app.css before jsdom computes it.
const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const declared = JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8"));

function dropStyle(theme, seam) {
  const vars = new Map([...Object.entries(declared.chrome).map(([name, value]) => [`--${name}`, value]),
    ["--r", theme.shape.r], ["--bw", theme.shape.bw], ["--focus", theme.dark.focus]]);
  const resolved = css.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name) => vars.get(name) ?? whole);
  const dom = new JSDOM(`<html data-seam="${seam}"><style>${resolved}</style><div class="drop" id="drop"></div></html>`);
  try {
    const style = dom.window.getComputedStyle(dom.window.document.getElementById("drop"));
    return { radius: style.borderRadius, width: style.borderTopWidth };
  } finally { dom.window.close(); }
}

test("the drop zone at the seam draws no radius and a border of the border width", () => {
  for (const theme of declared.themes) {
    assert.deepEqual(dropStyle(theme, "line"), { radius: "0px", width: theme.shape.bw }, theme.name);
  }
});

test("the drop zone with a gap keeps the radius of the theme and the drop border", () => {
  for (const theme of declared.themes) {
    assert.deepEqual(dropStyle(theme, "gap"), { radius: theme.shape.r, width: declared.chrome["drop-border"] }, theme.name);
  }
});
