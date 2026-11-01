// Checks the memory saver declaration of a section surface: a section surface is not a tab, so the background of a plugin does
// not apply to it, and a plugin that declares only sections has no tab plugin entry (docs/spec/plugins.md#memory-saver).
import assert from "node:assert/strict";
import test from "node:test";
import { unloadDeclaration } from "../memory-saver.js";
import { registerPlugin, registerSection } from "../registry.js";

test("a section surface takes its declaration from its own unload", () => {
  registerPlugin({ id: "fixture-background", background: { sidecar: "fixture", operation: "keep" }, surface: () => null });
  registerSection({ id: "fixture-sections.tree", name: "Tree", plugin: "fixture-sections", surface: () => null });
  registerSection({ id: "fixture-background.side", name: "Side", plugin: "fixture-background", surface: () => null });
  assert.equal(unloadDeclaration({ plugin: "fixture-background", kind: "tab", unload: false }), "background");
  assert.equal(unloadDeclaration({ plugin: "fixture-sections", kind: "section", unload: true }), "unload");
  assert.equal(unloadDeclaration({ plugin: "fixture-sections", kind: "section", unload: false }), "undeclared");
  assert.equal(unloadDeclaration({ plugin: "fixture-background", kind: "section", unload: false }), "undeclared");
});

test("only a tab of a plugin with background keeps its session through the background path", async () => {
  const { keepsBackground } = await import("../registry.js");
  assert.equal(keepsBackground({ plugin: "fixture-background", kind: "tab" }), true);
  assert.equal(keepsBackground({ plugin: "fixture-background", kind: "section" }), false);
  assert.equal(keepsBackground({ plugin: "fixture-sections", kind: "section" }), false);
});
