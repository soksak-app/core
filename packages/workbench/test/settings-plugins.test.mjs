import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

// The plugin section of the settings window holds only the settings of loaded plugins. Installation and description belong to the plugin page of the library
// (plugin section in docs/spec/settings.md).
test("the plugins section lists only loaded plugins by name and leaves operations to the plugin screen", async () => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  // The loaded plugins are the installed manifests that the environment registers. The registry lists no plugin that is not installed, so
  // a plugin that exists only in the registry has no unit and no row.
  const { installEnvironment } = await import("../environment.js");
  const surface = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
      { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "alpha", title: "알파" }] },
    ] } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [
    { id: "alpha", package: "@fixture/alpha", version: "1.0.0", manifest: {
      id: "alpha", name: "알파", description: "알파 표면.", mark: "a", icon: "<path/>", surface,
    } },
    // A plugin declares a surface, sections or contributions (validateManifest), so the plugin without a surface declares one section.
    { id: "beta", package: "@fixture/beta", version: "1.0.0", manifest: {
      id: "beta", name: "베타", description: "베타 목록.",
      sections: [{ id: "beta.list", name: "목록", height: "fill", composition: { kind: "view", page: "ui/list.html" } }],
    } },
  ] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js");
  try {
    ui.openSettings();
    ui.showSection("plugins");
    const list = ui.settingsModalState();
    assert.deepEqual(list.listed, ["alpha", "beta"]);
    const named = (name) => list.controls.filter((control) => control.name === name);
    assert.deepEqual(named("core.settings-modal.plugin").map((control) => control.label), ["알파", "베타"],
      "a plugin row shows more than the plugin name");
    assert.deepEqual(named("core.settings-modal.manage").map((control) => [control.label, control.command]),
      [["플러그인 관리", { name: "core.plugins.browse", params: {} }]]);
    assert.throws(() => ui.showPlugin("db"), /unknown plugin db/);

    ui.showPlugin("alpha");
    const page = ui.settingsModalState();
    assert.equal(page.plugin, "alpha");
    const card = document.getElementById("settings");
    assert.equal(card.textContent.includes("알파 표면."), false, "the plugin page shows the plugin description");
    assert.equal(card.querySelector("[data-plugin-versions]"), null, "the plugin page shows the plugin versions");
    assert.deepEqual(page.controls.filter((control) => control.command?.name.startsWith("core.plugins.")), [],
      "the plugin page has a plugin operation");
    ui.showPlugin(null);
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});
