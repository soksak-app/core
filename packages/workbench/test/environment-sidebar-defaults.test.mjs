import assert from "node:assert/strict";
import test from "node:test";

// The consumer fixture uses the declared manifest boundary instead of the implementation of the plugin.
const files = {
  "/environment.json": { runtime: "runtime", workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "fixture", title: "Fixture" }] } } } },
  card: { id: "fixture", name: "Fixture", description: "Fixture card.",
    mark: "f", icon: "<path/>", surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
    sidebars: { sets: [{ id: "main", title: "Main", sections: ["sections.tree"], layout: "list" }],
      card: { left: "main", top: "main" }, window: { right: "main" } } },
  sections: { id: "sections", name: "Sections", description: "Fixture sections.",
    exposes: { status: [{ name: "sections.tree", description: "Fixture status.", schema: { type: "object" } }] },
    sections: [{ id: "sections.tree", name: "Tree", composition: { kind: "view", page: "ui/tree.html" }, height: "fill" }],
    sidebars: { sets: [{ id: "tree", title: "Tree", sections: ["sections.tree"], layout: "tabs" }],
      window: { left: "tree" } } },
};
const installed = { plugins: [
  { id: "fixture", package: "@fixture/card", version: "0.0.1", folder: "/installed/plugin", manifest: files.card },
  { id: "sections", package: "@fixture/sections", version: "0.0.1", folder: "/installed/plugin", manifest: files.sections },
] };

test("an environment without sidebar overrides supplies normalized plugin defaults to settings", async () => {
  const { installEnvironment } = await import("../environment.js");
  const { defaults } = await import("../settings.js");
  installEnvironment(structuredClone(files["/environment.json"]), structuredClone(installed));
  const {section}=await import("../registry.js");
  assert.equal(section("sections.tree").plugin, "sections");
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
