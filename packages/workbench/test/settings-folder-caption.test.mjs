// The folder caption of the project scope shows the whole path inside the width of the pane: a line breaks at a space, after a
// hyphen and after a path separator, and a name wider than the line breaks at the end of the line (docs/spec/settings.md). Text
// does not break after a separator by itself, so the caption carries a break opportunity after each one, and only the caption lets
// a long name break: the body keeps its own breaking for the other text of the window.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = "/Users/someone/work-tree/a b/name\\with/" + "abcdefgh".repeat(14);

test("the folder caption of the project scope breaks after each separator and hyphen and never runs past the pane", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  // The active project is the project that the window shows. Its activation runs the layout listener of the plane (projects.js onSwitch), which
  // this unit test does not start, so the test gives the active project its root.
  t.mock.module("../projects.js", { exports: { ...await import("../projects.js"), active: () => ({ root }) } });
  // The settings of the project scope are the settings of the snapshot of the project, as the start document gives them (beginSettings).
  const { beginSettings } = await import("../settings.js");
  beginSettings({ common: {}, projects: [{ id: "fixture", root, title: "fixture", spaces: [], settings: {} }] }, "fixture");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js?folder");
  try {
    ui.openSettings();
    ui.showScope("project");
    const folder = document.querySelector('[data-expose="core.settings-modal.folder"]');
    assert.ok(folder, "the project scope has no element core.settings-modal.folder");
    assert.equal(folder.textContent, root, "the caption does not show the whole path");
    // Each separator and hyphen is followed by a break opportunity, and nothing else is.
    const breaks = [...folder.childNodes].map((node, index) => node.nodeName === "WBR" ? folder.childNodes[index - 1]?.textContent.at(-1) : null)
      .filter((text) => text !== null);
    const wanted = [...root].filter((char) => char === "/" || char === "\\" || char === "-");
    assert.deepEqual(breaks, wanted, `the caption breaks after ${JSON.stringify(breaks)}, not after each separator and hyphen`);
    assert.ok(folder.classList.contains("set-folder"), `the caption has the classes ${folder.className}`);
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    const rule = (selector) => css.match(new RegExp(`(?:^|\\})\\s*${selector.replace(".", "\\.")}\\{([^}]*)\\}`, "m"))?.[1];
    const own = rule(".set-folder");
    assert.ok(own, "app.css has no rule .set-folder");
    assert.match(own, /overflow-wrap:anywhere/, "a name wider than the line does not break at the end of the line");
    assert.doesNotMatch(own, /white-space|text-overflow|overflow:/, "the caption is shortened, kept on one line or cut off");
    assert.doesNotMatch(rule(".set-caption"), /overflow-wrap|word-break/, "the other captions change their line breaking");
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});
