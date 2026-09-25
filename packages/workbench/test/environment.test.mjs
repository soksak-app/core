import assert from "node:assert/strict";
import test from "node:test";

// 가짜 애플리케이션 파일. 실제 플러그인 이름과 경로를 사용하지 않는다.
const files = {
  "/environment.json": {
    runtime: "runtime",
    plugins: ["@fixture/card", "@fixture/side"],
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
  "/modules/@fixture/card/plugin.json": {
    id: "card", name: "Card", mark: "c", icon: "<path/>",
    surface: { module: "ui/card.js", composition: { kind: "dom" } }, sections: [{ id: "card.info", name: "Info", module: "ui/info.js" }],
    preview: { ink: "--fixture-ink" },
    settings: { "cursor.shape": { type: "enum", default: "block", values: ["block", "beam"] } },
  },
  "/modules/@fixture/side/plugin.json": { id: "side", name: "Side", sections: [{ id: "side.list", name: "List", module: "ui/list.js" }] },
  // release 빌드의 스테이징은 진단 선언이 없는 {} 를 둔다.
  "/diagnostic-plugins.json": {},
};
const requested = [];
globalThis.fetch = async (path) => {
  requested.push(path);
  const body = files[path];
  return body ? { ok: true, json: async () => structuredClone(body) } : { ok: false, status: 404 };
};

const { environment, loadEnvironment } = await import("../environment.js");
const registry = await import("../registry.js");
const settings = await import("../settings.js");

test("the environment registers card plugins, sections, and sidebar defaults", async () => {
  assert.throws(() => environment(), /not loaded/);
  await loadEnvironment();
  assert.deepEqual(requested, [
    "/environment.json", "/modules/@fixture/card/plugin.json", "/modules/@fixture/side/plugin.json",
    "/diagnostic-plugins.json",
  ]);
  assert.deepEqual(registry.plugins().map((p) => p.id), ["card"], "a plugin without a surface is not a card plugin");
  assert.deepEqual(registry.plugin("card").surface("tab 1"),
    { module: "/modules/@fixture/card/ui/card.js", composition: { kind: "dom" }, surfaceId: "tab 1", pluginId: "card", home: null, declarations: {}, sidecars: [] });
  assert.equal(registry.plugin("card").ink, "--fixture-ink");
  assert.equal(registry.plugin("card").diagnostics, null, "a release build has no plugin diagnostic module");
  assert.equal(registry.section("side.list").name, "List");
  assert.equal(registry.section("card.info").name, "Info");
  assert.equal(registry.section("side.list").module, "/modules/@fixture/side/ui/list.js", "a section module is served from its package");
  assert.deepEqual(settings.defaults.sets, files["/environment.json"].sidebars.sets);
  assert.deepEqual(settings.defaults.links, files["/environment.json"].sidebars.links);
  assert.equal(settings.value("card.cursor.shape"), "beam");
  assert.equal(settings.settingDefinitions()["card.cursor.shape"].default, "block");
  assert.equal(environment().workspace.focus, "main");
  await assert.rejects(loadEnvironment(), /already loaded/);
});
