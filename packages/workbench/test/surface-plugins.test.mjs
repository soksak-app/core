// Checks that the plugins that draw a surface are the plugins of the tab surfaces and of the section surfaces: a plugin that declares
// only sections draws its section surfaces natively too (docs/spec/plugins.md#sections).
import assert from "node:assert/strict";
import test from "node:test";
import * as registry from "../registry.js";

const { registerPlugin, registerSection, surfacePlugins } = registry;

test("a plugin with only sections is a plugin that draws a surface, once", () => {
  registerPlugin({ id: "fixture-tab", surface: () => null });
  registerSection({ id: "fixture-sections.tree", name: "Tree", plugin: "fixture-sections", surface: () => null });
  registerSection({ id: "fixture-sections.marks", name: "Marks", plugin: "fixture-sections", surface: () => null });
  registerSection({ id: "fixture-tab.side", name: "Side", plugin: "fixture-tab", surface: () => null });
  assert.deepEqual(surfacePlugins(), ["fixture-tab", "fixture-sections"]);
});

test("a section surface id names the plugin of its registered section", () => {
  assert.equal(typeof registry.sectionSurfacePlugin, "function", "registry.js exports sectionSurfacePlugin");
  assert.equal(registry.sectionSurfacePlugin("spc-aaaaaa/left/fixture-sections.tree"), "fixture-sections");
  assert.equal(registry.sectionSurfacePlugin("spc-aaaaaa/right/fixture-tab.side"), "fixture-tab");
  assert.equal(registry.sectionSurfacePlugin("spc-aaaaaa/left/unknown.section"), null, "a section that is not registered has no plugin");
  assert.equal(registry.sectionSurfacePlugin("tab-aaaaaa"), null, "a tab surface is not a section surface");
});
