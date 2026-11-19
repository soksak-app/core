// Red tests of the party and card queries and of the party status (docs/spec/parties.md#queries and #describe). The commands
// core.party.get and core.card.get and the status core.parties are not registered yet, so each test fails on the unchanged
// implementation at its first query.
import assert from "node:assert/strict";
import test from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

test("core.card.get of a card in a party reports the party, the leader flag and the tabs in tab order", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a" });
    const card = await window.run("core.card.get", { card: "a" });
    assert.deepEqual(Object.keys(card), ["card", "party", "leader", "activeTab", "tabs"]);
    assert.equal(card.party, "p1");
    assert.equal(card.leader, true);
    assert.equal(card.tabs.length, 1);
    assert.equal(card.tabs[0].plugin, "probe-plain");
  } finally {
    window.close();
  }
});

test("core.card.get of a card in no party reports party null and leader false", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    const card = await window.run("core.card.get", { card: "b" });
    assert.equal(card.party, null);
    assert.equal(card.leader, false);
  } finally {
    window.close();
  }
});

test("core.card.get of an unknown card is refused with unknown card <id>", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await assert.rejects(window.run("core.card.get", { card: "zz" }), /^Error: unknown card zz$/);
  } finally {
    window.close();
  }
});

test("a tab whose plugin declares no summary has an empty status object", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    const card = await window.run("core.card.get", { card: "a" });
    assert.deepEqual(card.tabs[0].status, {});
  } finally {
    window.close();
  }
});

test("core.party.get lists the leader first and the other members in space order", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b", "c"], leader: "c" });
    const party = await window.run("core.party.get", { party: "p1" });
    assert.deepEqual(Object.keys(party), ["id", "cards", "leader", "color", "leaderColor", "outline", "reason", "members"]);
    assert.deepEqual(party.members.map((member) => member.card), ["c", "a", "b"]);
    assert.equal(party.leaderColor, null);
  } finally {
    window.close();
  }
});

test("the outline of a party is a list of closed loops of [x, y] points", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const party = await window.run("core.party.get", { party: "p1" });
    assert.ok(Array.isArray(party.outline) && party.outline.length >= 1);
    for (const loop of party.outline) {
      assert.ok(loop.length >= 3);
      for (const point of loop) assert.deepEqual(point.length, 2);
    }
  } finally {
    window.close();
  }
});

test("the core.parties status lists one party record per party with the declared fields", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    await window.run("core.party.create", { cards: ["c", "d"] });
    const { result } = await window.get("core.parties");
    assert.deepEqual(result.map((party) => party.id), ["p1", "p2"]);
    assert.deepEqual(Object.keys(result[0]), ["id", "cards", "leader", "color", "leaderColor", "outline", "reason"]);
  } finally {
    window.close();
  }
});

test("core.party.get reports the same record as the core.parties status for the same party", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const { result } = await window.get("core.parties");
    const party = await window.run("core.party.get", { party: "p1" });
    assert.deepEqual(result[0], {
      id: party.id, cards: party.cards, leader: party.leader, color: party.color,
      leaderColor: party.leaderColor, outline: party.outline, reason: party.reason,
    });
  } finally {
    window.close();
  }
});
