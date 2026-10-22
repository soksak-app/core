import assert from "node:assert/strict";
import test from "node:test";

// A fake application file. It uses no real plugin name or path.
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
    sections: [{ id: "card.info", name: "Info", status: "card.info" }],
    preview: { ink: "--fixture-ink" }, dependencies: { "@fixture/sidecar-card": "^0.1.0" },
    sidebars: { sets: [{ id: "info", title: "Info", sections: ["card.info"], layout: "tabs" }], card: { top: "info" } },
    settings: { "cursor.shape": { label: "커서 모양", type: "enum", default: "block", values: ["block", "beam"] } },
  },
  side: {
    id: "side", name: "Side", description: "검사용 섹션.", host: { page: "ui/host.html" },
    exposes: { status: [{ name: "side.count", description: "검사용 상태.", schema: { type: "object" } }, { name: "side.list", description: "검사용 상태.", schema: { type: "object" } }] },
    sections: [{ id: "side.list", name: "List", status: "side.list" }, { id: "side.count", name: "Count", status: "side.count" }],
  },
};
// The install list of a release build has no diagnostics declaration.
const installed = { plugins: [
  { id: "card", package: "@fixture/card", version: "0.0.1", manifest: files.card },
  { id: "side", package: "@fixture/side", version: "0.0.1", manifest: files.side },
] };

const { environment, installEnvironment, pluginDiagnostics } = await import("../environment.js");
const registry = await import("../registry.js");
const settings = await import("../settings.js");
const { pluginSidecarsOf } = await import("../plugin-host.js");

test("the environment registers card plugins, sections, and sidebar defaults from the installed manifests", async () => {
  assert.throws(() => environment(), /not loaded/);
  assert.doesNotThrow(() => installEnvironment(structuredClone(files["/environment.json"]), structuredClone(installed)), "the environment was rejected");
  assert.deepEqual(registry.plugins().map((p) => p.id), ["card"], "a plugin without a surface is not a card plugin");
  const { contributions, ...target } = registry.plugin("card").surface("tab 1");
  assert.deepEqual(target,
    { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] }, surfaceId: "tab 1", pluginId: "card", declarations: { status: [{ name: "card.info", description: "검사용 상태.", schema: { type: "object" } }] }, sidecars: ["@fixture/sidecar-card"], unload: false });
  // card declares no extension point, so every point is undeclared.
  assert.throws(() => contributions("language"), /extension point language is not declared by card/);
  assert.equal(registry.plugin("card").ink, "--fixture-ink");
  assert.equal(await pluginDiagnostics("card"), null, "a release build has no plugin diagnostic module");
  assert.equal(registry.section("side.list").name, "List");
  assert.equal(registry.section("card.info").name, "Info");
  assert.equal(registry.section("side.list").module, undefined, "a status section has no module");
  assert.equal(registry.section("side.count").status, "side.count", "a status section keeps its status");
  assert.equal(registry.section("side.count").module, undefined, "a status section has a module");
  assert.deepEqual(settings.defaults.sets, files["/environment.json"].sidebars.sets);
  assert.deepEqual(settings.defaults.links, files["/environment.json"].sidebars.links);
  assert.equal(settings.value("card.cursor.shape"), "beam");
  assert.equal(settings.settingDefinitions()["card.cursor.shape"].default, "block");
  assert.equal(environment().workspace.focus, "main");
  assert.throws(() => installEnvironment(files["/environment.json"], installed), /already loaded/);
});

test("the environment declares each installed plugin's dependencies to its plugin host as sidecars", () => {
  // A dependency is a sidecar of the plugin host. The page has no sidecar.json, so the declaration is null, and the host refuses
  // every operation of the sidecar (docs/plans/plugin-host-routes.md rule 8).
  assert.deepEqual(pluginSidecarsOf("card"), [{ name: "@fixture/sidecar-card", declared: [], declaration: null }]);
  assert.deepEqual(pluginSidecarsOf("side"), []);
});
