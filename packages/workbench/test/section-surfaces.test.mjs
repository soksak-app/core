// Checks the record of the section surfaces of the shown space and the rule that keeps stored entries at a load
// (docs/spec/plugins.md#sections, docs/spec/projects.md).
import assert from "node:assert/strict";
import test from "node:test";
import { shownSectionSurfaces, showSectionSurface, hideSectionSurface, storedSurfaceKept } from "../section-surfaces.js";

test("the shown section surfaces are the ones that a drawn sidebar holds", () => {
  showSectionSurface("left/probe.tree");
  showSectionSurface("c1:right/probe.dom");
  showSectionSurface("left/probe.tree");
  hideSectionSurface("c1:right/probe.dom");
  assert.deepEqual(shownSectionSurfaces(), ["left/probe.tree"]);
  hideSectionSurface("left/probe.tree");
  assert.deepEqual(shownSectionSurfaces(), []);
});

test("a load keeps the entries of layout tabs, window sidebar sections and sections of cards of a layout", () => {
  const kept = storedSurfaceKept(new Set(["tab-a"]), new Set(["c1", "c2"]));
  assert.equal(kept("tab-a"), true);
  assert.equal(kept("tab-gone"), false);
  assert.equal(kept("left/probe.tree"), true);
  assert.equal(kept("right/probe.dom"), true);
  assert.equal(kept("c1:top/probe.marks"), true);
  assert.equal(kept("c9:left/probe.tree"), false, "a section of a closed card is dropped");
  assert.equal(kept("middle/probe.tree"), false, "a sidebar that is neither a window sidebar nor a card sidebar is dropped");
});
