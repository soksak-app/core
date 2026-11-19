// The name of a card tab that does not fit is cut as CSS text-overflow: ellipsis cuts a line (docs/spec/example-model.md#card-tabs): as
// many leading characters as fit beside the ellipsis, and the first character cut rather than replaced in a room narrower than it and
// the ellipsis, which WebKit draws from these rules. jsdom does not compute var(), so the test reads the rules of app.css with the values
// of workbench.json written in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const declared = JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8"));

test("the name of the active tab of a head that fits one tab is cut with an ellipsis on one line", { timeout: 5000 }, () => {
  const vars = new Map(Object.entries(declared.chrome).map(([name, value]) => [`--${name}`, value]));
  const resolved = css.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name) => vars.get(name) ?? whole);
  const dom = new JSDOM(`<style>${resolved}</style><div class="chrome" data-fit="one"><div class="chrome__tabs"><span class="tab"
    data-active="true" id="tab"><span class="tab__name" id="name">터미널</span><button class="tab__x">&#10005;</button></span></div></div>`);
  try {
    const name = dom.window.getComputedStyle(dom.window.document.getElementById("name"));
    assert.deepEqual({ overflow: name.overflow, textOverflow: name.textOverflow, whiteSpace: name.whiteSpace, minWidth: name.minWidth },
      { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0px" }, "the name of the tab");
    const tab = dom.window.getComputedStyle(dom.window.document.getElementById("tab"));
    assert.deepEqual({ flexShrink: tab.flexShrink, minWidth: tab.minWidth }, { flexShrink: "1", minWidth: "0px" }, "the active tab narrows to its room");
  } finally { dom.window.close(); }
});
