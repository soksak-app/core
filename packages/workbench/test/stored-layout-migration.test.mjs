import assert from "node:assert/strict";
import test from "node:test";

import { migrateStoredLayout } from "../stored-layout-migration.js";

// 이전 형식(edgeWidth, railWidth)으로 저장한 배치는 읽을 때 한 번 현재 형식으로 바뀐다(docs/spec/projects.md).
test("an earlier window sidebar layout is converted to window sidebar records", () => {
  const kept = { state: { cards: [] }, focusedId: "main", named: 0, sidebars: {},
    railWidth: { "plugin-a": 190, "plugin-b": 157.2 }, edgeWidth: { left: 190, right: 210 } };
  const { layout, changes } = migrateStoredLayout(kept);
  assert.deepEqual(layout, { state: { cards: [] }, focusedId: "main", named: 0, sidebars: {},
    windowSidebars: { left: { width: 190 }, right: { width: 210 } } });
  assert.deepEqual(changes, ["edgeWidth became windowSidebars", "railWidth was dropped because rail cards no longer exist"]);
  assert.equal(Object.hasOwn(kept, "windowSidebars"), false, "the stored input was changed in place");
});

test("a current layout is left as it is", () => {
  const kept = { state: { cards: [] }, focusedId: "main", named: 0, windowSidebars: { left: { width: 200 } } };
  const { layout, changes } = migrateStoredLayout(kept);
  assert.equal(layout, kept);
  assert.deepEqual(changes, []);
});

test("a layout with both formats or an invalid earlier width is rejected", () => {
  assert.throws(() => migrateStoredLayout({ state: { cards: [] }, edgeWidth: { left: 190 }, windowSidebars: {} }),
    /stored layout has both edgeWidth and windowSidebars/);
  assert.throws(() => migrateStoredLayout({ state: { cards: [] }, edgeWidth: { left: "wide" } }),
    /stored edgeWidth left is not a width/);
});

test("earlier card panels and the inset sidebar become card sidebars", () => {
  const kept = { state: { cards: [
    { id: "card-a", data: { tabs: [], activeId: null, panels: { left: { set: "set-one" }, right: { set: "set-two", size: 210 }, top: { set: null } } } },
    { id: "card-1", data: { tabs: [], activeId: null, sidebar: { width: 230, collapsed: true } } },
    { id: "card-2", data: { tabs: [], activeId: null, panels: { left: { set: "set-one" } }, sidebar: { width: 200, collapsed: false } } },
    { id: "left", data: null },
  ] }, windowSidebars: {} };
  const { layout, changes } = migrateStoredLayout(kept);
  assert.deepEqual(layout.state.cards.map((card) => card.data?.sidebars ?? null), [
    { left: { set: "set-one" }, right: { set: "set-two", size: 210 } },
    { left: { size: 230, collapsed: true } },
    { left: { set: "set-one" } },
    null,
  ]);
  assert.ok(layout.state.cards.every((card) => !card.data || (!("panels" in card.data) && !("sidebar" in card.data))));
  assert.deepEqual(changes, [
    "card card-a: panels became sidebars",
    "card card-1: the inset sidebar became the left sidebar",
    "card card-2: panels became sidebars",
    "card card-2: the inset sidebar was dropped because the card assigns its left sidebar",
  ]);
  assert.ok("panels" in kept.state.cards[0].data, "the stored input was changed in place");
});

test("an inset sidebar choice keyed by its card becomes the card's left sidebar choice", () => {
  const kept = { state: { cards: [{ id: "card-a", data: { tabs: [], activeId: null } }, { id: "card-b", data: { tabs: [], activeId: null } },
    { id: "left", data: null }] }, windowSidebars: {},
  sidebars: { left: { tab: "a" }, "card-a": { tab: "b" }, "card-b": { tab: "c" }, "card-b:left": { tab: "d" } } };
  const { layout, changes } = migrateStoredLayout(kept);
  assert.deepEqual(layout.sidebars, { left: { tab: "a" }, "card-a:left": { tab: "b" }, "card-b:left": { tab: "d" } });
  assert.deepEqual(changes, ["sidebar choice card-a became card-a:left",
    "sidebar choice card-b was dropped because card-b:left is stored"]);
});
