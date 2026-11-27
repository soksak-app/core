// The verifier of the agent layout requests (docs/spec/cases/agent-layout/requests.json, F959-1). Each predicate has a layout that meets
// it and a layout that breaks it. The layouts are the card frames that `core.grid` reports, and the uneven row is the widths that the
// repeated splits of F957 measured on the current code before the fix (594, 392, 291 and 230.4 points).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { judge } from "../agent-layout.mjs";

const { requests } = JSON.parse(readFileSync(new URL("../../docs/spec/cases/agent-layout/requests.json", import.meta.url), "utf8"));
const predicatesOf = (name) => requests.find((request) => request.name === name).predicates;

// A card of core.grid: its frame, its plugin per tab, and the group card that holds it.
const card = (id, x, y, w, h, plugins = ["terminal"], parent = null) => ({
  id, x, y, w, h, parent, tabs: plugins.map((plugin) => ({ plugin })),
});
const row = (widths) => {
  let x = 0;
  return widths.map((w, i) => {
    const frame = card(`card-${i + 1}`, x, 0, w, 800);
    x += w;
    return frame;
  });
};

test("a row of four equal cards meets the row predicate", () => {
  assert.deepEqual(judge(row([391, 391, 391, 391]), predicatesOf("row-of-four-equal-cards")), []);
});

test("the uneven row of repeated splits breaks the row predicate", () => {
  const failures = judge(row([594, 392, 291, 230.4]), predicatesOf("row-of-four-equal-cards"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /equal/);
});

test("a row of three cards breaks the row predicate on the count", () => {
  assert.equal(judge(row([400, 400, 400]), predicatesOf("row-of-four-equal-cards")).length, 1);
});

test("a two by two grid meets the grid predicate", () => {
  const grid = [card("a", 0, 0, 600, 400), card("b", 600, 0, 600, 400), card("c", 0, 400, 600, 400), card("d", 600, 400, 600, 400)];
  assert.deepEqual(judge(grid, predicatesOf("grid-two-by-two")), []);
});

test("a row of three cards breaks the grid predicate", () => {
  assert.equal(judge(row([400, 400, 400]), predicatesOf("grid-two-by-two")).length, 1);
});

test("two cards with two plugins meet the plugin predicate", () => {
  const cards = [card("a", 0, 0, 600, 800, ["terminal"]), card("b", 600, 0, 600, 800, ["browser"])];
  assert.deepEqual(judge(cards, predicatesOf("split-card-with-two-plugins")), []);
});

test("two cards with one plugin break the plugin predicate", () => {
  const cards = [card("a", 0, 0, 600, 800, ["terminal"]), card("b", 600, 0, 600, 800, ["terminal"])];
  assert.equal(judge(cards, predicatesOf("split-card-with-two-plugins")).length, 1);
});

test("two groups of two cards meet the group predicate", () => {
  const cards = [card("a", 0, 0, 300, 400, ["terminal"], "group-1"), card("b", 300, 0, 300, 400, ["terminal"], "group-1"),
    card("c", 0, 400, 600, 400, ["terminal"], "group-2"), card("d", 600, 400, 600, 400, ["terminal"], "group-2")];
  assert.deepEqual(judge(cards, predicatesOf("two-groups-of-cards")), []);
});

test("one group breaks the group predicate", () => {
  const cards = [card("a", 0, 0, 300, 400, ["terminal"], "group-1"), card("b", 300, 0, 300, 400, ["terminal"], "group-1")];
  assert.equal(judge(cards, predicatesOf("two-groups-of-cards")).length, 1);
});

// A window starts with its window sidebars, which are fixed cards of the plane beside the content cards (docs/spec/external-sidebars.md).
// The predicates judge the content cards only, so the sidebars of the window do not count (F959-3).
test("the window sidebars of a window do not count as cards of the layout", () => {
  const sidebar = (id, x) => ({ ...card(id, x, 0, 190, 646), fixed: true });
  const content = row([182, 182, 182, 182]).map((frame) => ({ ...frame, x: frame.x + 190 }));
  const cards = [sidebar("left", 0), ...content, sidebar("right", 190 + 728)];
  assert.deepEqual(judge(cards, predicatesOf("row-of-four-equal-cards")), []);
  assert.deepEqual(judge(cards, predicatesOf("grid-two-by-two")).length, 1);
});
