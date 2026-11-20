// The frame of a group card in the page workbench (docs/spec/groups.md#drawn-rectangles, docs/spec/groups.md#drawing): the header is
// the band of head-h at the top of the frame rectangle, and the line and the radius of the frame run around the whole card, over the
// ends of the header, whose content starts the head padding inside the line as in the head of a content card. JSDOM has no layout
// engine, so the test reads the declared values of the stylesheet that the page loads; the window checks of the hosts measure the
// rectangles.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = await readFile(new URL("../app.css", import.meta.url), "utf8");

test("the header of a group card is the band at the top of its frame and the line of the frame runs over it", { timeout: 5000 }, () => {
  const dom = new JSDOM(`<style>${css}</style>`);
  try {
    // JSDOM computes no style of a pseudo-element, so the test reads the declarations of the rules of the stylesheet.
    const rules = new Map([...dom.window.document.styleSheets[0].cssRules].map((rule) => [rule.selectorText, rule.style]));
    const frame = rules.get(".group");
    assert.deepEqual(["border", "border-width", "border-top-width"].map((name) => frame.getPropertyValue(name)), ["", "", ""],
      "the frame element has no border, so its header starts at its top");
    const line = rules.get(".group::after");
    assert.ok(line, "the line of the frame is a box over the frame element");
    assert.deepEqual(
      Object.fromEntries(["content", "position", "inset", "border", "border-radius", "pointer-events"].map((name) => [name, line.getPropertyValue(name)])),
      { content: '""', position: "absolute", inset: "0px", border: "var(--bw) solid var(--edge)", "border-radius": "inherit", "pointer-events": "none" },
      "the line of the frame is drawn over the header and takes no press");
    assert.equal(rules.get(".group__head").getPropertyValue("padding"), "0 calc(var(--card-head-pad) + var(--bw))",
      "the content of the header starts the head padding inside the line");
  } finally {
    dom.window.close();
  }
});
