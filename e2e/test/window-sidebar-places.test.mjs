// Checks the measures of the window check of the four sides against grids and sidebar reports whose places are known
// (docs/spec/external-sidebars.md#verification).
import assert from "node:assert/strict";
import test from "node:test";
import { SIDES, orders, placeMismatches, reportMismatches, thicknesses } from "../window-sidebar-places.mjs";

const card = (id, x, y, w, h) => ({ id, x, y, w, h, tabs: [] });
const content = card("main", 196, 196, 608, 408);
content.tabs = [{ id: "tab", plugin: "layoutprobe" }];
const grid = (...cards) => ({ width: 1000, height: 800, gap: 6, plane: { x: 0, y: 40 }, cards: [content, ...cards] });
// The default order: left and right reach across the height, top and bottom stand between them.
const ordered = grid(card("left", 0, 0, 190, 800), card("right", 810, 0, 190, 800), card("top", 196, 0, 608, 190), card("bottom", 196, 610, 608, 190));
// Top first: the top sidebar reaches across the width, the left and right sidebars stand below it.
const topFirst = grid(card("top", 0, 0, 1000, 190), card("left", 0, 196, 190, 604), card("right", 810, 196, 190, 604), card("bottom", 196, 610, 608, 190));

test("the orders of the four sides are the 24 arrangements of the four sides", () => {
  const all = orders();
  assert.equal(all.length, 24);
  assert.equal(new Set(all.map((order) => order.join())).size, 24);
  for (const order of all) assert.deepEqual([...order].sort(), [...SIDES].sort());
});

test("sidebars that stand where the order places them have no mismatch", () => {
  assert.deepEqual(placeMismatches(ordered, SIDES, SIDES), []);
  assert.deepEqual(placeMismatches(topFirst, ["top", "left", "right", "bottom"], SIDES), []);
  // Two sides of one axis next to each other in the order change nothing that is drawn.
  assert.deepEqual(placeMismatches(ordered, ["right", "left", "bottom", "top"], SIDES), []);
});

test("a sidebar that stands where another order places it is named with its reach", () => {
  const found = placeMismatches(topFirst, SIDES, SIDES);
  assert.ok(found.some((line) => line.startsWith("left ") && line.includes("starts at 196")), found.join("; "));
  assert.ok(found.some((line) => line.startsWith("top ") && line.includes("starts at 0")), found.join("; "));
});

test("a missing sidebar, a sidebar of a side that holds none and a sidebar off its border are named", () => {
  const without = grid(card("left", 0, 0, 190, 800), card("right", 810, 0, 190, 800), card("top", 196, 0, 608, 190));
  assert.deepEqual(placeMismatches(without, SIDES, SIDES), ["bottom is missing"]);
  assert.deepEqual(placeMismatches(ordered, SIDES, ["left", "right", "top"]), ["bottom stands although its side holds no sidebar"]);
  const off = grid(card("left", 4, 0, 190, 800), card("right", 810, 0, 190, 800), card("top", 196, 0, 608, 190), card("bottom", 196, 610, 608, 190));
  assert.ok(placeMismatches(off, SIDES, SIDES).includes("left stands at 4 on x, not at its border 0"));
});

test("a subset of the sides reaches the border where no earlier sidebar stands", () => {
  const two = grid(card("left", 0, 0, 190, 800), card("top", 196, 0, 804, 190));
  assert.deepEqual(placeMismatches(two, ["left", "top", "right", "bottom"], ["left", "top"]), []);
  const found = placeMismatches(two, ["top", "left", "right", "bottom"], ["left", "top"]);
  assert.ok(found.some((line) => line.startsWith("top ")), found.join("; "));
});

test("a sidebar whose thickness changed is named with both thicknesses", () => {
  const thick = thicknesses(ordered);
  assert.deepEqual(thick, { left: 190, right: 190, top: 190, bottom: 190 });
  assert.deepEqual(placeMismatches(topFirst, ["top", "left", "right", "bottom"], SIDES, thick), []);
  const thinner = grid(card("left", 0, 0, 150, 800), card("right", 810, 0, 190, 800), card("top", 156, 0, 648, 190), card("bottom", 156, 610, 648, 190));
  assert.deepEqual(placeMismatches(thinner, SIDES, SIDES, thick), ["left is 150 thick on x, expected 190"]);
});

// The report of a window sidebar inside its card, as both workbenches report it.
const report = (sidebar, orientation, item) => ({ sidebar, side: sidebar, placement: "window", orientation,
  rect: { x: ordered.plane.x + item.x + 1, y: ordered.plane.y + item.y + 1, w: item.w - 2, h: item.h - 24 }, sections: [] });
const reports = SIDES.map((side) => report(side, side === "left" || side === "right" ? "vertical" : "horizontal",
  ordered.cards.find((item) => item.id === side)));

test("core.sidebars that reports one window sidebar of each side inside its card has no mismatch", () => {
  assert.deepEqual(reportMismatches(reports, ordered, SIDES), []);
  const cardSidebar = { sidebar: "main:left", side: null, placement: "card", orientation: "vertical", rect: { x: 0, y: 0, w: 1, h: 1 }, sections: [] };
  assert.deepEqual(reportMismatches([...reports, cardSidebar], ordered, SIDES), []);
});

test("a missing report, a second report, a wrong orientation and a rect outside the card are named", () => {
  assert.deepEqual(reportMismatches(reports.slice(1), ordered, SIDES), ["core.sidebars reports 0 window sidebars of left, expected 1"]);
  assert.deepEqual(reportMismatches([...reports, reports[0]], ordered, SIDES), ["core.sidebars reports 2 window sidebars of left, expected 1"]);
  const turned = reports.map((item) => (item.sidebar === "top" ? { ...item, orientation: "vertical" } : item));
  assert.deepEqual(reportMismatches(turned, ordered, SIDES), ["top reports the orientation vertical, expected horizontal"]);
  const outside = reports.map((item) => (item.sidebar === "right" ? { ...item, rect: { ...item.rect, x: item.rect.x + 20 } } : item));
  assert.deepEqual(reportMismatches(outside, ordered, SIDES), [`right reports the rect ${JSON.stringify({ ...reports[1].rect, x: reports[1].rect.x + 20 })} outside its card at x 810, y 40, w 190, h 800`]);
});
