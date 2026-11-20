// The lines of the seam in the page workbench (docs/spec/groups.md#drawing, the row gap of docs/spec/settings.md): at gap 0 a group card
// draws no border of its own, the mark of the focus colors the line outside its frame, the line under its header is the bottom line of
// the header, and the stage shares its top line with the space bar and its left line with the project column. The page draws these
// lines from the computed style, so the computed style is the drawn shape. jsdom does not compute var(), so the test writes the values
// that the page sets on the root (the chrome metrics of workbench.json and the tokens of each theme) into app.css before jsdom computes it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const declared = JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8"));

/** The computed lines of a group card, its header and the stage with or without the project column, in theme at seam. */
function seamStyle(theme, seam, column) {
  const vars = new Map([...Object.entries(declared.chrome).map(([name, value]) => [`--${name}`, value]),
    ...Object.entries(theme.light).map(([name, value]) => [`--${name}`, value]), ["--r", theme.shape.r], ["--bw", theme.shape.bw],
    // The share that the plane writes on a marked frame (markHeldFocus of group-cards.js).
    ["--group-focus", "60%"]]);
  // jsdom computes no style of a pseudo-element, so the line of the frame, the ::after box of a group card, is computed on a child
  // element that the rules of ::after select instead.
  const resolved = css.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name) => vars.get(name) ?? whole).replaceAll(".group::after", ".group > .after")
    .replaceAll(".group[data-focus]::after", ".group[data-focus] > .after");
  const dom = new JSDOM(`<html data-seam="${seam}" data-focus-ind="border"><style>${resolved}</style>
    <div class="workarea">${column ? '<div class="project-column"></div>' : ""}<div class="work"><div class="tabs tabs--space"></div>
    <main class="stage" id="stage"><div class="plane"><section class="group" id="plain"><header class="group__head" id="head"></header><i class="after" id="line"></i></section>
    <section class="group" id="marked" data-focus="1" style="--group-focus: 60%"></section></div></main></div></div></html>`);
  try {
    const of = (id) => dom.window.getComputedStyle(dom.window.document.getElementById(id));
    return {
      frame: of("line").borderTopWidth,
      markOutline: `${of("marked").outlineWidth} ${of("marked").outlineStyle}`,
      head: `${of("head").borderBottomWidth} ${of("head").borderBottomStyle}`,
      stage: `${parseFloat(of("stage").marginTop) || 0}px ${parseFloat(of("stage").marginLeft) || 0}px`,
    };
  } finally { dom.window.close(); }
}

test("at the seam a group card draws no border, its mark colors the line outside its frame and its header draws the line below it", { timeout: 5000 }, () => {
  for (const theme of declared.themes) {
    const bw = theme.shape.bw;
    assert.deepEqual(seamStyle(theme, "line", false), { frame: "0px", markOutline: `${bw} solid`, head: `${bw} solid`, stage: `-${bw} 0px` },
      `${theme.name} at the seam`);
    assert.equal(seamStyle(theme, "line", true).stage, `-${bw} -${bw}`, `${theme.name}: the stage shares its left line with the project column`);
  }
});

test("with a gap a group card keeps its border, its header draws the line below it as the head of a card, and the stage stands apart from the bars", { timeout: 5000 }, () => {
  for (const theme of declared.themes) {
    const style = seamStyle(theme, "gap", true);
    assert.deepEqual({ frame: style.frame, head: style.head, stage: style.stage }, { frame: theme.shape.bw, head: `${theme.shape.bw} solid`,
      stage: "0px 0px" }, `${theme.name} with a gap`);
    assert.notEqual(style.markOutline.split(" ")[1], "solid", `${theme.name}: the mark draws no outline with a gap`);
  }
});
