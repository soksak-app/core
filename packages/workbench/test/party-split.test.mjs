// Red tests of the split rule and the closed card rule (docs/spec/parties.md#changes-of-the-layout). The party module and the
// party commands are absent, so each test fails on the unchanged implementation at its first command. The space order of a test is
// the order of the card list that openPartyWindow receives. Each card touches the next card of that order.
import assert from "node:assert/strict";
import test from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

test("a split keeps the part that holds the leader and the other part leaves the party", { timeout: 10000 }, async () => {
  // a b c d e with leader e. Removing c splits the rest into a b and d e; the part with the leader stays.
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b", "c", "d", "e"], leader: "e" });
    await window.run("core.party.remove", { party: "p1", card: "c" });
    const party = await window.run("core.party.get", { party: "p1" });
    assert.deepEqual([...party.cards].sort(), ["d", "e"]);
    assert.equal(party.leader, "e");
    assert.equal((await window.run("core.card.get", { card: "a" })).party, null);
    assert.equal((await window.run("core.card.get", { card: "b" })).party, null);
  } finally {
    window.close();
  }
});

test("without a leader a split keeps the part with the most cards", { timeout: 10000 }, async () => {
  // a b c d e f without leader. Removing b splits the rest into a and c d e f; the part with more cards stays.
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b", "c", "d", "e", "f"] });
    await window.run("core.party.remove", { party: "p1", card: "b" });
    const party = await window.run("core.party.get", { party: "p1" });
    assert.deepEqual([...party.cards].sort(), ["c", "d", "e", "f"]);
    assert.equal(party.leader, null);
    assert.equal((await window.run("core.card.get", { card: "a" })).party, null);
  } finally {
    window.close();
  }
});

test("without a leader and with equal counts a split keeps the part whose first card comes first in the space order", { timeout: 10000 }, async () => {
  // a b c d e without leader. Removing c splits the rest into a b and d e, both with 2 cards; a comes first in the space order.
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b", "c", "d", "e"] });
    await window.run("core.party.remove", { party: "p1", card: "c" });
    assert.deepEqual([...(await window.run("core.party.get", { party: "p1" })).cards].sort(), ["a", "b"]);
  } finally {
    window.close();
  }
});

test("closing a card of a party removes the card from the party with reason closed", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["n", "o", "p"] });
    await window.run("core.card.close", { card: "p" });
    const party = await window.run("core.party.get", { party: "p1" });
    assert.deepEqual([...party.cards].sort(), ["n", "o"]);
    assert.equal(party.reason, "closed");
  } finally {
    window.close();
  }
});

test("a removal that leaves a party with fewer than 2 cards deletes the party and keeps its cards in the layout", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    await window.run("core.party.remove", { party: "p1", card: "a" });
    await assert.rejects(window.run("core.party.get", { party: "p1" }), /^Error: unknown party p1$/);
    assert.equal((await window.run("core.card.get", { card: "b" })).party, null);
  } finally {
    window.close();
  }
});
