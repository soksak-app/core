// The notice target of a tab id among the cards of the layout (docs/spec/notifications.md#card-status-line).
import assert from "node:assert/strict";
import { test } from "node:test";
import { noticeTargetIn } from "../card-data.js";

const cards = [
  { id: "main", data: { tabs: [{ id: "tab-a", plugin: "plain", title: "A" }, { id: "tab-b", plugin: "notes", title: "B" }], activeId: "tab-a" } },
  { id: "side", data: { tabs: [{ id: "tab-c", plugin: "term", title: "C" }], activeId: "tab-c" } },
  { id: "left", data: null },
];

test("a tab id names the card that holds it, with the tab, its plugin and its title as label", () => {
  assert.deepEqual(noticeTargetIn(cards, "tab-b"), { card: "main", tab: "tab-b", plugin: "notes", label: "B" });
  assert.deepEqual(noticeTargetIn(cards, "tab-c"), { card: "side", tab: "tab-c", plugin: "term", label: "C" });
});

test("a tab id that no card holds names no target, and a card without data holds no tab", () => {
  assert.equal(noticeTargetIn(cards, "tab-missing"), null);
  assert.equal(noticeTargetIn([], "tab-a"), null);
});
