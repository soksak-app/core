// The card menu items of the party rules (docs/spec/parties.md#card-menu): a card in no party has group items for its touching cards and
// no leader, color or take item; a card in a party has the leader item, the six color items and no group item. The items come from the real
// party module of the page window (partyMenuItems).
import assert from "node:assert/strict";
import { test } from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

test("a card in no party offers group items for its touching cards only (docs/spec/parties.md#card-menu)", { timeout: 10000 }, async () => {
  const { partyMenuItems } = await import("../parties.js");
  const window = await openPartyWindow();
  try {
    await window.reset();
    const items = partyMenuItems("a");
    assert.ok(items.length > 0, "a touching card gives a group item");
    assert.ok(items.every((item) => item.element === "core.party.menu.group"), "only group items");
    assert.deepEqual(items[0].params, { cards: ["a", "b"] });
  } finally {
    window.close();
  }
});

test("a card in a party offers the leader item and the six color items (docs/spec/parties.md#card-menu)", { timeout: 10000 }, async () => {
  const { partyMenuItems } = await import("../parties.js");
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a" });
    const items = partyMenuItems("a");
    assert.deepEqual(items.filter((item) => item.element === "core.party.menu.leader").map((item) => item.params), [{ party: "p1", leader: null }]);
    assert.equal(items.filter((item) => item.element === "core.party.menu.color").length, 6);
    assert.ok(items.every((item) => item.element !== "core.party.menu.group"), "no group item for a card in a party");
  } finally {
    window.close();
  }
});
