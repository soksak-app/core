// The card menu items of the party rules (docs/spec/parties.md#card-menu): a card in no party has group items for its touching cards and
// no leader, color or take item; a card in a party has the leader item, the six color items and no group item. The items come from the real
// party module of the page window (partyMenuItems).
import assert from "node:assert/strict";
import { test } from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

test("a card in no party has the touching cards in no party as its group candidates (docs/spec/parties.md#card-menu)", { timeout: 10000 }, async () => {
  const { groupCandidates, partyMenuItems } = await import("../parties.js");
  const window = await openPartyWindow();
  try {
    await window.reset();
    assert.deepEqual(groupCandidates("a"), ["b"]);
    assert.deepEqual(groupCandidates("b"), ["a", "c"]);
    assert.ok(partyMenuItems("a").every((item) => item.element !== "core.party.menu.group"), "the group item is the chooser, not a party item");
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

test("a party item of the card menu closes the picker when it runs (docs/spec/parties.md#card-menu)", { timeout: 10000 }, async () => {
  const { openCardTools } = await import("../plane.js");
  const window = await openPartyWindow();
  try {
    await window.reset();
    openCardTools("a");
    const button = document.querySelector('#picker .picker__item[data-expose="core.party.menu.group"]');
    assert.ok(button, "the group item of the card is drawn in the picker");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await window.get("core.parties")).result.length, 1, "the group item created the party");
    assert.equal((await window.get("core.picker")).result.open, false, "the picker is closed after the party item runs");
  } finally {
    window.close();
  }
});

test("the group chooser of a card creates one party from the touching cards that the person selects (docs/spec/parties.md#card-menu)", { timeout: 10000 }, async () => {
  const { openCardTools } = await import("../plane.js");
  const window = await openPartyWindow();
  const choose = (selector) => {
    const button = document.querySelector(`#picker ${selector}`);
    assert.ok(button, `the picker draws ${selector}`);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };
  try {
    await window.reset();
    openCardTools("b");
    choose('.picker__item[data-expose="core.party.menu.group"]');
    assert.ok(document.querySelector('#picker .picker__item[data-key="card-a"]'), "the chooser lists card a");
    assert.equal(document.querySelector('#picker .picker__item[data-key="confirm"]'), null, "no confirm item before a card is selected");
    choose('.picker__item[data-key="card-a"]');
    choose('.picker__item[data-key="card-c"]');
    choose('.picker__item[data-key="confirm"]');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { result: parties } = await window.get("core.parties");
    assert.equal(parties.length, 1, "the confirm item creates one party");
    assert.deepEqual([...parties[0].cards].sort(), ["a", "b", "c"], "the party holds the card and the two selected cards");
    assert.equal((await window.get("core.picker")).result.open, false, "the picker is closed after the confirm item runs");
  } finally {
    window.close();
  }
});
