import assert from "node:assert/strict";
import test from "node:test";
import { railSidebars, windowSidebarCards } from "../window-sidebars.js";

const units = [{ id: "pane" }, { id: "tree" }];
const present = (id) => id === "left" || id === "right";

test("general sidebars do not create a rail border", () => {
  assert.deepEqual(railSidebars(windowSidebarCards(units, [{ place: "right", plugin: null, set: "general" }], "pane"), present), []);
});

test("only the applied plugin override joins the focused card to fixed sidebars", () => {
  const links = [{ place: "right", plugin: null, set: "general" },
    { place: "window-right", plugin: "pane", set: "pane-set" },
    { place: "window-left", plugin: "tree", set: "tree-set" }];
  assert.deepEqual(railSidebars(windowSidebarCards(units, links, "pane"), present), ["right"]);
  assert.deepEqual(railSidebars(windowSidebarCards(units, links, "tree"), present), ["left"]);
  assert.deepEqual(railSidebars(windowSidebarCards(units, links, "tree"), (id) => id === "right"), [], "a sidebar missing from the grid joins no rail");
});
