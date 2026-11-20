// The errors of the card status row (docs/spec/plugins.md#tab-reports, docs/spec/example-model.md): the error of a stopped surface and the
// operation error of the active tab stay on the one line of the row, cut with an ellipsis, and the whole text is the tooltip of the element.
// jsdom does not compute var(), so the test reads the rules of app.css with the values of workbench.json written in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const declared = JSON.parse(readFileSync(new URL("../workbench.json", import.meta.url), "utf8"));
const LONG = "the save of the document failed because the folder is not writable ".repeat(8).trim();

test("an error of the status row stays on one line and is cut with an ellipsis", { timeout: 5000 }, () => {
  const vars = new Map(Object.entries(declared.chrome).map(([name, value]) => [`--${name}`, value]));
  const resolved = css.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name) => vars.get(name) ?? whole);
  const dom = new JSDOM(`<style>${resolved}</style><section class="card"><footer class="status"><span class="surface-status" id="surface"
    data-surface-status="error" data-error="surface status card-1 tab-a">표면 오류 · ${LONG}</span><span class="status__text">~/project</span>
    <span class="status__error" id="tab" data-error="tab error tab-a">${LONG}</span></footer></section>`);
  try {
    for (const id of ["surface", "tab"]) {
      const style = dom.window.getComputedStyle(dom.window.document.getElementById(id));
      const drawn = {
        display: style.display, whiteSpace: style.whiteSpace, overflow: style.overflow, textOverflow: style.textOverflow,
        minWidth: style.minWidth, flexShrink: style.flexShrink,
      };
      assert.deepEqual(drawn, { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0px", flexShrink: "1" },
        `the ${id} error of the status row`);
    }
  } finally { dom.window.close(); }
});

test("an error of the status row carries its whole text as its tooltip until it is withdrawn", { timeout: 5000 }, async () => {
  const dom = new JSDOM(`<section data-card-id="card-1"><footer class="status"></footer></section>`);
  globalThis.document = dom.window.document;
  const { setSurfaceStatus, setTabError } = await import("../surface-status.js?tooltip");
  const status = document.querySelector(".status");
  try {
    setSurfaceStatus(status, "tab-a", { phase: "error", error: LONG });
    const indicator = status.querySelector("[data-surface-status]");
    assert.equal(indicator.title, `표면 오류 · ${LONG}`, "the surface error carries its whole text as its tooltip");
    setSurfaceStatus(status, "tab-a", { phase: "loading" });
    assert.equal(indicator.hasAttribute("title"), false, "the loading state carries no tooltip of the error");

    setTabError(status, "tab-a", LONG);
    const line = status.querySelector(".status__error");
    assert.deepEqual({ text: line.textContent, title: line.title, hidden: line.hidden, where: line.dataset.error },
      { text: LONG, title: LONG, hidden: false, where: "tab error tab-a" }, "the tab error carries its whole text as its tooltip");
    setTabError(status, "tab-a", null);
    assert.deepEqual({ hidden: line.hidden, title: line.hasAttribute("title"), where: line.dataset.error },
      { hidden: true, title: false, where: undefined }, "a removed tab error carries no tooltip");
  } finally {
    dom.window.close();
    delete globalThis.document;
  }
});
