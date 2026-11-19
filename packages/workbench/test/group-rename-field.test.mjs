// The rename field of a group header in the page workbench (docs/spec/groups.md#headers): it is the rename field of a project or a space
// tab, and the stylesheet places it in the place of the name, with its text where the text of the name started, and gives it the
// selection of the theme. JSDOM has no layout engine, so the test reads the declared values of the stylesheet that the page loads; the
// window checks of the hosts measure the rectangles.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = await readFile(new URL("../app.css", import.meta.url), "utf8");
const { default: declaration } = await import("../workbench.json", { with: { type: "json" } });

test("the rename field of a group takes the place of the name with its text where the text of the name started", { timeout: 5000 }, () => {
  const dom = new JSDOM(`<style>${css}</style><div class="group__head"><span class="group__name">그룹 1</span>` +
    `<input class="bar-tab__root group__rename"></div>`);
  try {
    const of = (selector) => dom.window.getComputedStyle(dom.window.document.querySelector(selector));
    assert.equal(of(".group__name").getPropertyValue("padding-left"), "var(--tab-pad-x)", "the text of the name is inset as the title of a tab");
    assert.equal(of(".group__rename").getPropertyValue("margin-left"), "calc(var(--tab-pad-x) - var(--bw) - var(--bar-tab-root-pad))",
      "the text of the field starts where the text of the name started");
    assert.equal(of(".group__rename").getPropertyValue("flex"), "1 1 0px", "the field grows over the place of the name");
    assert.equal(of(".group__rename").getPropertyValue("height"), "var(--bar-tab-root-h)", "the field has the height of the rename field of a tab");
    assert.equal(of(".group__rename").getPropertyValue("font-size"), "var(--text-small)", "the text of the field keeps the size of the name");
    assert.equal(declaration.chrome["rename-selection-mix"], "35%");
  } finally {
    dom.window.close();
  }
});

test("the rename field selects in the focus color mixed into bg", { timeout: 5000 }, () => {
  const dom = new JSDOM(`<style>${css}</style>`);
  try {
    const rules = [...dom.window.document.styleSheets[0].cssRules].filter((rule) => rule.selectorText === ".bar-tab__root::selection");
    assert.equal(rules.length, 1, "the stylesheet declares one selection of the rename field");
    assert.equal(rules[0].style.getPropertyValue("background"), "color-mix(in srgb,var(--focus) var(--rename-selection-mix),var(--bg))");
    assert.equal(rules[0].style.getPropertyValue("color"), "var(--fg)");
  } finally {
    dom.window.close();
  }
});
