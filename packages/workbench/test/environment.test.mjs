import assert from "node:assert/strict";
import test from "node:test";

// An application file fixture. It uses no real plugin name or path.
const files = {
  "/environment.json": {
    runtime: "runtime",
    workspace: {
      focus: "main",
      grid: {
        xs: [0, 0.3, 1], ys: [0, 1],
        cards: [
          { id: "left", c0: 0, c1: 1, r0: 0, r1: 1, width: 190, fixed: true },
          { id: "main", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [{ plugin: "card", title: "c 1" }, { plugin: "card", title: "c 2" }] },
        ],
      },
    },
    sidebars: {
      sets: [{ id: "set-a", title: "A", sections: ["side.list", "card.info"], layout: "list" }],
      links: [{ place: "left", plugin: null, set: "set-a" }],
    },
    settings: { card: { "cursor.shape": "beam" } },
  },
  card: {
    id: "card", name: "Card", description: "검사용 카드.", mark: "c", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } }, exposes: { status: [{ name: "card.info", description: "검사용 상태.", schema: { type: "object" } }] },
    sections: [{ id: "card.info", name: "Info", composition: { kind: "view", page: "ui/info.html" }, height: 120 }],
    preview: { ink: "--fixture-ink" }, dependencies: { "@fixture/sidecar-card": "^0.1.0" },
    sidebars: { sets: [{ id: "info", title: "Info", sections: ["card.info"], layout: "tabs" }], card: { top: "info" } },
    settings: { "cursor.shape": { label: "커서 모양", type: "enum", default: "block", values: ["block", "beam"] } },
  },
  side: {
    id: "side", name: "Side", description: "검사용 섹션.",
    exposes: { status: [{ name: "side.count", description: "검사용 상태.", schema: { type: "object" } }, { name: "side.list", description: "검사용 상태.", schema: { type: "object" } }] },
    sections: [{ id: "side.list", name: "List", composition: { kind: "view", page: "ui/list.html" }, height: "fill" },
      { id: "side.count", name: "Count", composition: { kind: "view", page: "ui/count.html" }, height: 48, unload: { format: 1, maxBytes: 4096 } }],
  },
};
// The install list of a release build has no diagnostics declaration.
const installed = { plugins: [
  { id: "card", package: "@fixture/card", version: "0.0.1", manifest: files.card },
  { id: "side", package: "@fixture/side", version: "0.0.1", manifest: files.side },
] };

const { environment, installEnvironment, pluginDiagnostics, pluginUnits } = await import("../environment.js");
const registry = await import("../registry.js");
const settings = await import("../settings.js");

test("the environment registers card plugins, sections, and sidebar defaults from the installed manifests", async () => {
  assert.throws(() => environment(), /not loaded/);
  assert.doesNotThrow(() => installEnvironment(structuredClone(files["/environment.json"]), structuredClone(installed)), "the environment was rejected");
  assert.deepEqual(pluginUnits().map(({ id, composition }) => ({ id, composition })), [
    { id: "card", composition: "view" }, { id: "side", composition: null },
  ], "loaded plugin metadata must preserve composition without opening a tab");
  assert.deepEqual(registry.plugins().map((p) => p.id), ["card"], "a plugin without a surface is not a card plugin");
  const { contributions, ...target } = registry.plugin("card").surface("tab 1");
  assert.deepEqual(target,
    { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] }, surfaceId: "tab 1", pluginId: "card", declarations: { status: [{ name: "card.info", description: "검사용 상태.", schema: { type: "object" } }] }, sidecars: ["@fixture/sidecar-card"], diagnostics: null, unload: false });
  // card declares no extension point, so every point is undeclared.
  assert.throws(() => contributions("language"), /extension point language is not declared by card/);
  assert.equal(registry.plugin("card").ink, "--fixture-ink");
  assert.equal(await pluginDiagnostics("card"), null, "a release build has no plugin diagnostic module");
  assert.equal(registry.section("side.list").name, "List");
  assert.equal(registry.section("card.info").name, "Info");
  assert.equal(registry.section("side.list").height, "fill");
  assert.equal(registry.section("side.count").plugin, "side");
  // A section registers the builder of its section surface, which carries its composition, unload and start value section.
  const start = { id: "side.count", sidebar: "left", card: null };
  const counted = registry.section("side.count").surface("spc-aaaaaa/left/side.count", start);
  assert.deepEqual([counted.composition, counted.surfaceId, counted.pluginId, counted.unload, counted.params, counted.section],
    [{ kind: "view", page: "ui/count.html" }, "spc-aaaaaa/left/side.count", "side", { format: 1, maxBytes: 4096 }, null, start]);
  assert.equal(registry.section("side.list").surface("spc-aaaaaa/left/side.list", start).unload, false, "a section without unload is never unloaded");
  assert.deepEqual(settings.defaults.sets, files["/environment.json"].sidebars.sets);
  assert.deepEqual(settings.defaults.links, files["/environment.json"].sidebars.links);
  assert.equal(settings.value("card.cursor.shape"), "beam");
  assert.equal(settings.settingDefinitions()["card.cursor.shape"].default, "block");
  assert.equal(environment().workspace.focus, "main");
  assert.throws(() => installEnvironment(files["/environment.json"], installed), /already loaded/);
});
