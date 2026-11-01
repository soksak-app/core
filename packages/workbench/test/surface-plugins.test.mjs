// Checks that the plugins that draw a surface are the plugins of the tab surfaces and of the section surfaces: a plugin that declares
// only sections draws its section surfaces natively too (docs/spec/plugins.md#sections).
import assert from "node:assert/strict";
import test from "node:test";
import { registerPlugin, registerSection, surfacePlugins } from "../registry.js";

test("a plugin with only sections is a plugin that draws a surface, once", () => {
  registerPlugin({ id: "fixture-tab", surface: () => null });
  registerSection({ id: "fixture-sections.tree", name: "Tree", plugin: "fixture-sections", surface: () => null });
  registerSection({ id: "fixture-sections.marks", name: "Marks", plugin: "fixture-sections", surface: () => null });
  registerSection({ id: "fixture-tab.side", name: "Side", plugin: "fixture-tab", surface: () => null });
  assert.deepEqual(surfacePlugins(), ["fixture-tab", "fixture-sections"]);
});
