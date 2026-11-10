// Checks the record of the section surfaces of the shown space and the rule that keeps stored entries at a load
// (docs/spec/plugins.md#sections, docs/spec/projects.md).
import assert from "node:assert/strict";
import test from "node:test";
import { spaceSectionSurfaces, shownSectionSurfaces, showSectionSurface, hideSectionSurface, storedSurfaceKept } from "../section-surfaces.js";

test("the shown section surfaces are the ones that a drawn sidebar holds", () => {
  showSectionSurface("spc-aaaaaa/left/probe.tree");
  showSectionSurface("spc-aaaaaa/card-1:right/probe.dom");
  showSectionSurface("spc-aaaaaa/left/probe.tree");
  hideSectionSurface("spc-aaaaaa/card-1:right/probe.dom");
  assert.deepEqual(shownSectionSurfaces(), ["spc-aaaaaa/left/probe.tree"]);
  hideSectionSurface("spc-aaaaaa/left/probe.tree");
  assert.deepEqual(shownSectionSurfaces(), []);
});

test("a load keeps the entries of layout tabs and of the sections of a space of a layout, keyed by that space", () => {
  // A section surface id is <space>/<sidebar>/<section> (docs/spec/plugins.md#sections): window sidebars repeat in every window and
  // card ids restart in each space, so the space makes the id name one surface.
  const kept = storedSurfaceKept(new Set(["tab-a"]), new Map([["spc-aaaaaa", new Set(["card-1", "card-2"])], ["spc-bbbbbb", new Set(["card-1"])]]));
  assert.equal(kept("tab-a"), true);
  assert.equal(kept("tab-gone"), false);
  assert.equal(kept("spc-aaaaaa/left/probe.tree"), true);
  assert.equal(kept("spc-bbbbbb/right/probe.dom"), true);
  assert.equal(kept("spc-aaaaaa/top/probe.tree"), true, "the top window sidebar keeps its section");
  assert.equal(kept("spc-bbbbbb/bottom/probe.dom"), true, "the bottom window sidebar keeps its section");
  assert.equal(kept("spc-aaaaaa/card-2:top/probe.marks"), true);
  assert.equal(kept("spc-bbbbbb/card-2:top/probe.marks"), false, "a card of another space does not keep the section");
  assert.equal(kept("spc-cccccc/left/probe.tree"), false, "a section of a removed space is dropped");
  assert.equal(kept("spc-aaaaaa/middle/probe.tree"), false, "a sidebar that is neither a window sidebar nor a card sidebar is dropped");
  assert.equal(kept("left/probe.tree"), false, "an id without a space is dropped");
});

test("a space holds the sections of the top and bottom window sidebars (docs/spec/external-sidebars.md)", () => {
  const sets = [{ id: "wide", sections: ["alpha.tree"] }, { id: "plugin", sections: ["beta.list"] }];
  const links = [{ place: "top", plugin: null, set: "wide" }, { place: "window-bottom", plugin: "beta", set: "plugin" }];
  assert.deepEqual(spaceSectionSurfaces("spc", [], sets, links), ["spc/top/alpha.tree", "spc/bottom/beta.list"]);
});

test("a space holds the sections of the sets of its window sidebars and of the sides of its cards", () => {
  const sets = [
    { id: "wide", sections: ["alpha.tree", "alpha.bookmarks"] },
    { id: "plugin", sections: ["beta.list"] },
    { id: "card", sections: ["gamma.tabs"] },
    { id: "chosen", sections: ["gamma.history"] },
  ];
  const links = [
    { place: "left", plugin: null, set: "wide" },
    { place: "window-left", plugin: "beta", set: "plugin" },
    { place: "window-right", plugin: "beta", set: "wide" },
    { place: "card-top", plugin: "gamma", set: "card" },
    { place: "card-left", plugin: "gamma", set: "gone" },
  ];
  const cards = [
    { id: "seat" },
    { id: "one", data: { tabs: [{ id: "a", plugin: "beta" }, { id: "b", plugin: "gamma" }], activeId: "a" } },
    { id: "two", data: { tabs: [{ id: "c", plugin: "gamma" }], activeId: "c", sidebars: { top: { set: "off" }, bottom: { set: "chosen" } } } },
  ];
  assert.deepEqual(spaceSectionSurfaces("spc", cards, sets, links), [
    "spc/left/alpha.tree", "spc/left/alpha.bookmarks", "spc/left/beta.list",
    "spc/right/alpha.tree", "spc/right/alpha.bookmarks",
    "spc/one:top/gamma.tabs",
    "spc/two:bottom/gamma.history",
  ], "a set that is gone and a side that is off hold nothing, and a tab that is not active keeps its link");
});
