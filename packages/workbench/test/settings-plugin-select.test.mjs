// Checks that the plugin page of a plugin draws a setting of the type plugin as a select box of the loaded and enabled plugins of its category, by
// name, with the stored value selected (docs/spec/settings.md#controls).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the plugin page of a plugin with a plugin setting shows a select of the plugins of its category by name", async () => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  const surface = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "cli", title: "씨엘아이" }] } } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [
    { id: "cli", package: "@fixture/cli", version: "1.0.0", folder: "/installed/plugin", manifest: {
      id: "cli", name: "씨엘아이", description: "명령 도구.", mark: "c", icon: "<path/>", surface, requires: ["terminal"],
      settings: { shell: { type: "plugin", category: "terminal", label: "셸", description: "셸로 쓸 터미널 플러그인." } },
    } },
    { id: "term", package: "@fixture/term", version: "1.0.0", folder: "/installed/plugin", manifest: {
      id: "term", name: "터미널", description: "터미널 표면.", mark: "t", icon: "<path/>", surface, categories: ["terminal"],
    } },
  ] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js");
  try {
    ui.openSettings();
    ui.showSection("plugins");
    ui.showPlugin("cli");
    const select = document.querySelector('select[data-set="cli.shell"]');
    assert.ok(select, "the plugin setting is not drawn as a select box");
    assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [["term", "터미널"]],
      "the select does not list the plugins of the category by name");
    assert.equal(select.value, "term", "the one plugin of the category is not selected");
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});
