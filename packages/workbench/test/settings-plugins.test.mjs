import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

// 설정 창의 플러그인 절은 불러온 플러그인의 설정만 담는다. 설치와 설명은 라이브러리의 플러그인 페이지가 맡는다
// (docs/spec/settings.md 의 플러그인 절).
test("the plugins section lists only loaded plugins by name and leaves operations to the plugin screen", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.mock.module("../compositor.js", { exports: {
    ...await import("../compositor.js"), standIn: () => {},
  } });
  t.mock.module("../environment.js", { exports: { pluginUnits: () => [
    { id: "alpha", name: "알파", description: "알파 표면.", version: "1.0.0", surface: true, sections: [], sidecars: [] },
    { id: "beta", name: "베타", description: "베타 목록.", version: "1.0.0", surface: false, sections: [], sidecars: [] },
  ] } });
  // 레지스트리에만 있는 플러그인은 설정 창에 나오지 않는다.
  const status = {
    registry: "file:///registry/index.json", error: null, restart: false, operation: null,
    plugins: [
      { id: "alpha", name: "알파", description: "알파 표면.", state: "loaded", installed: { version: "1.0.0", enabled: true }, latest: "1.0.0", sidecars: [] },
      { id: "beta", name: "베타", description: "베타 목록.", state: "loaded", installed: { version: "1.0.0", enabled: true }, latest: null, sidecars: [] },
      { id: "db", name: "DB", description: "DB 설명.", state: "available", installed: null, latest: "2.0.0", sidecars: [] },
    ],
  };
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: { hosted: true, status: () => status, failure: () => null, refresh: async () => {} },
    onPluginOperations: () => {},
  } });
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
