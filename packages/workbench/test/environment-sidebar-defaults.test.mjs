import assert from "node:assert/strict";
import test from "node:test";

// 소비자 픽스처는 패키지 구현 대신 선언된 manifest 경계를 사용한다.
const files = {
  "/environment.json": { runtime: "runtime", workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
      { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "fixture", title: "Fixture" }] },
    ] } } },
  "/modules/@fixture/card/plugin.json": { id: "fixture", name: "Fixture", description: "Fixture card.",
    mark: "f", icon: "<path/>", surface: { module: "ui/card.js", composition: { kind: "dom" } },
    sidebars: { sets: [{ id: "main", title: "Main", sections: ["sections.tree"], layout: "list" }],
      card: { left: "main", top: "main" }, window: { right: "main" } } },
  "/modules/@fixture/sections/plugin.json": { id: "sections", name: "Sections", description: "Fixture sections.",
    sections: [{ id: "sections.tree", name: "Tree", module: {horizontal:"ui/tree-horizontal.js",vertical:"ui/tree-vertical.js"} }],
    sidebars: { sets: [{ id: "tree", title: "Tree", sections: ["sections.tree"], layout: "tabs" }],
      window: { left: "tree" } } },
  "/installed-plugins.json": { plugins: [{ id: "fixture", package: "@fixture/card", version: "0.0.1" }, { id: "sections", package: "@fixture/sections", version: "0.0.1" }] },
};

test("an environment without sidebar overrides supplies normalized plugin defaults to settings", async (t) => {
  t.mock.method(globalThis, "fetch", async (path) => {
    const body = files[path];
    return body ? { ok: true, json: async () => structuredClone(body) } : { ok: false, status: 404 };
  });
  const { loadEnvironment } = await import("../environment.js");
  const { defaults } = await import("../settings.js");
  await loadEnvironment();
  const {section}=await import("../registry.js");
  assert.deepEqual(section("sections.tree").module,{horizontal:"/modules/@fixture/sections/ui/tree-horizontal.js",vertical:"/modules/@fixture/sections/ui/tree-vertical.js"});
  assert.deepEqual(defaults.sets, [
    { id: "fixture.main", title: "Main", sections: ["sections.tree"], layout: "list" },
    { id: "sections.tree", title: "Tree", sections: ["sections.tree"], layout: "tabs" },
  ]);
  assert.deepEqual(defaults.links, [
    { place: "card-left", plugin: "fixture", set: "fixture.main" },
    { place: "card-top", plugin: "fixture", set: "fixture.main" },
    { place: "window-right", plugin: "fixture", set: "fixture.main" },
    { place: "window-left", plugin: "sections", set: "sections.tree" },
  ]);
});
