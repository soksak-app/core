// Checks the height of the seat of a settings view in the settings window of the Wails and Tauri hosts (docs/spec/plugins.md#settings-views,
// F1213): the seat stands at the height 0 until the view reports its content height with runtime.seat.height, and then takes each
// height that the view reports, whatever the height and the scroll of the pane.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the seat of the settings view takes the content height that the view reports", async () => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const { installEnvironment } = await import("../environment.js");
  const surface = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "fixture", title: "Fixture" }] } } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: "fixture", package: "@fixture/fixture", version: "1.0.0", folder: "/installed/plugin", manifest: {
    id: "fixture", name: "Fixture", description: "Fixture card.", mark: "f", icon: "<path/>", surface, settingsView: { page: "ui/settings.html" },
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js");
  const view = await import("../settings-view.js");
  const seat = () => document.querySelector('[data-expose="core.settings-modal.plugin-view"]');
  try {
    ui.openSettings();
    ui.showSection("plugins");
    ui.showPlugin("fixture");
    assert.equal(seat().style.height, "0px", "the seat has no height before the first report");
    view.setSeatHeight("settings/fixture", 180);
    assert.equal(seat().style.height, "180px");
    view.setSeatHeight("settings/fixture", 64);
    assert.equal(seat().style.height, "64px");
    ui.drawSettings();
    assert.equal(seat().style.height, "64px", "a new draw of the page keeps the reported height");
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});
