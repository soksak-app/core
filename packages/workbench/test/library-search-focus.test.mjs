import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the declared cmd+k command targets the shown library page and rejects a hidden library", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  documentInputs(dom.window.document);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  let visible = true;
  let page = "projects";
  const actualProjects = await import("../projects.js");
  t.mock.module("../projects.js", { exports: { ...actualProjects, inLibrary: () => visible } });

  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const shortcut = JSON.parse(readFileSync(new URL("../shortcuts.json", import.meta.url), "utf8")).shortcuts
    .find((row) => row.key === "cmd+k" && row.owner === "workbench");
  assert.ok(shortcut, "the workbench cmd+k row was not declared");
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    await installCoreExposure({
      library: { state: () => ({ page }), actions: {} },
      renames: { state: () => null }, chrome: () => null, drawn: async () => {},
    });

    await registry.run("core.library.search.focus", {});
    assert.equal(document.activeElement.dataset.expose, "core.library.search");

    page = "plugins";
    await registry.run(shortcut.command, {});
    assert.equal(document.activeElement.dataset.expose, "core.library.plugins.search");

    visible = false;
    await assert.rejects(registry.run(shortcut.command, {}), /library is not shown/);
    assert.equal(page, "plugins");
    assert.equal(document.activeElement.dataset.expose, "core.library.plugins.search");
  } finally {
    dom.window.close();
  }
});

function documentInputs(document) {
  for (const name of ["core.library.search", "core.library.plugins.search"]) {
    const input = document.createElement("input");
    input.dataset.expose = name;
    document.body.append(input);
  }
}
