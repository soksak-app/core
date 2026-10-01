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

test("the rail stroke lies inside the half gap so whole device pixels hold it", async () => {
  const { railOutlineOptions } = await import("../window-sidebars.js");
  // 선 굵기 1 의 선은 반 통로 6 의 안쪽 1 픽셀을 채우도록 중심이 5.5 에 놓인다.
  assert.deepEqual(railOutlineOptions(12, 10, 1), { pad: 5.5, radius: 15.5 });
  assert.deepEqual(railOutlineOptions(12, 0, 2), { pad: 5, radius: 0 });
  assert.deepEqual(railOutlineOptions(1, 0, 1), { pad: 0, radius: 0 }, "a seam keeps the stroke on the card edge");
});
