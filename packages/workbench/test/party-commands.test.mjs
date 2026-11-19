// Red tests of the party commands (docs/spec/parties.md#commands). The commands core.party.create, update, add, remove and delete are
// not registered yet, and the party module does not exist, so each test here fails on the unchanged implementation: the import of
// ../parties.js (through the support module) fails and the commands are absent. The tests state the reply shapes and refusal texts
// of the specification and nothing else.
import assert from "node:assert/strict";
import test from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

const HEX = /^#[0-9a-fA-F]{6}$/;

// contract: workbench.parties.commands
test("core.party.create of two touching cards makes one party with the first identifier p1 and no leader", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    const reply = await window.run("core.party.create", { cards: ["a", "b"] });
    assert.equal(reply.party.id, "p1");
    assert.deepEqual(reply.party.cards, ["a", "b"]);
    assert.equal(reply.party.leader, null);
    assert.match(reply.party.color, HEX);
    assert.deepEqual(reply.taken, []);
    assert.deepEqual(reply.changed, [{ party: "p1", removed: [], leader: null, deleted: false }]);
  } finally {
    window.close();
  }
});

test("core.party.create with the card set of an existing party returns that party with changed []", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    const first = await window.run("core.party.create", { cards: ["a", "b"] });
    const again = await window.run("core.party.create", { cards: ["b", "a"] });
    assert.deepEqual(again.party, first.party);
    assert.deepEqual(again.changed, []);
    assert.equal((await window.get("core.parties")).result.length, 1);
  } finally {
    window.close();
  }
});

test("core.party.create with fewer than 2 cards is refused with a party needs at least 2 cards", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await assert.rejects(window.run("core.party.create", { cards: ["a"] }), /^Error: a party needs at least 2 cards$/);
  } finally {
    window.close();
  }
});

test("core.party.create of cards that do not touch is refused and changes nothing", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await assert.rejects(window.run("core.party.create", { cards: ["a", "c"] }), /^Error: cards are not touching: /);
    assert.deepEqual((await window.get("core.parties")).result, []);
  } finally {
    window.close();
  }
});

test("core.party.create of an unknown card is refused with unknown card <id>", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await assert.rejects(window.run("core.party.create", { cards: ["a", "zz"] }), /^Error: unknown card zz$/);
  } finally {
    window.close();
  }
});

test("core.party.create that lists a card twice is refused with card <id> is listed more than once", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await assert.rejects(window.run("core.party.create", { cards: ["a", "a", "b"] }), /^Error: card a is listed more than once$/);
  } finally {
    window.close();
  }
});

test("core.party.create stores a chosen color as given, with no normalization", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    const reply = await window.run("core.party.create", { cards: ["a", "b"], color: "#ABCDEF" });
    assert.equal(reply.party.color, "#ABCDEF");
  } finally {
    window.close();
  }
});

test("core.party.create with a color that is not #rrggbb is refused with color must be #rrggbb", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await assert.rejects(window.run("core.party.create", { cards: ["a", "b"], color: "red" }), /^Error: color must be #rrggbb$/);
  } finally {
    window.close();
  }
});

test("core.party.create with a leader that is not in the party is refused with leader <id> is not in the party", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await assert.rejects(window.run("core.party.create", { cards: ["a", "b"], leader: "c" }), /^Error: leader c is not in the party$/);
  } finally {
    window.close();
  }
});

test("core.party.create of a card that another party holds is refused with card <id> belongs to party <party>", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["c", "d"] });
    await assert.rejects(window.run("core.party.create", { cards: ["a", "b", "c"] }), /^Error: card c belongs to party p1$/);
  } finally {
    window.close();
  }
});

test("core.party.create gives two touching parties different default colors", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    const first = await window.run("core.party.create", { cards: ["a", "b"] });
    const second = await window.run("core.party.create", { cards: ["c", "d"] });
    assert.notEqual(first.party.color, second.party.color);
  } finally {
    window.close();
  }
});

test("the seventh party of a space takes the first default color when all six are used", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    const colors = [];
    for (const pair of [["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"], ["i", "j"], ["k", "l"], ["m", "n"]]) {
      colors.push((await window.run("core.party.create", { cards: pair })).party.color);
    }
    assert.equal(new Set(colors.slice(0, 6)).size, 6);
    assert.equal(colors[6], colors[0]);
  } finally {
    window.close();
  }
});

test("core.party.update with leader null removes the leader and reports the party as changed", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a" });
    const reply = await window.run("core.party.update", { party: "p1", leader: null });
    assert.equal(reply.party.leader, null);
    assert.deepEqual(reply.changed, [{ party: "p1", removed: [], leader: null, deleted: false }]);
  } finally {
    window.close();
  }
});

test("core.party.update with leaderColor null makes the leader color follow party-leader", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a", leaderColor: "#112233" });
    const reply = await window.run("core.party.update", { party: "p1", leaderColor: null });
    assert.equal(reply.party.leaderColor, null);
  } finally {
    window.close();
  }
});

test("core.party.update of an unknown party is refused with unknown party <id>", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await assert.rejects(window.run("core.party.update", { party: "p9", color: "#112233" }), /^Error: unknown party p9$/);
  } finally {
    window.close();
  }
});

test("repeating a core.party.update request gives the same reply and changes nothing the second time", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const first = await window.run("core.party.update", { party: "p1", color: "#112233" });
    const second = await window.run("core.party.update", { party: "p1", color: "#112233" });
    assert.deepEqual(second.party, first.party);
    assert.deepEqual(second.changed, []);
  } finally {
    window.close();
  }
});

test("core.party.add of a touching card that no party holds adds it to the party", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const reply = await window.run("core.party.add", { party: "p1", card: "c" });
    assert.deepEqual(reply.party.cards, ["a", "b", "c"]);
    assert.deepEqual(reply.taken, []);
    assert.deepEqual(reply.changed, [{ party: "p1", removed: [], leader: null, deleted: false }]);
  } finally {
    window.close();
  }
});

test("core.party.add of a card that does not touch the party is refused and changes nothing", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    await assert.rejects(window.run("core.party.add", { party: "p1", card: "d" }), /^Error: cards are not touching: /);
    assert.deepEqual((await window.run("core.party.get", { party: "p1" })).cards, ["a", "b"]);
  } finally {
    window.close();
  }
});

test("core.party.add of a card of another party without take is refused with card <id> belongs to party <party>", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    await window.run("core.party.create", { cards: ["c", "d"] });
    await assert.rejects(window.run("core.party.add", { party: "p1", card: "c" }), /^Error: card c belongs to party p2$/);
  } finally {
    window.close();
  }
});

test("core.party.remove removes the card and reports it as removed from the party", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b", "c"] });
    const reply = await window.run("core.party.remove", { party: "p1", card: "c" });
    assert.deepEqual(reply.party.cards, ["a", "b"]);
    assert.deepEqual(reply.changed, [{ party: "p1", removed: ["c"], leader: null, deleted: false }]);
  } finally {
    window.close();
  }
});

test("core.party.delete deletes the party and keeps its cards in the layout", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const reply = await window.run("core.party.delete", { party: "p1" });
    assert.deepEqual(reply.changed, [{ party: "p1", removed: ["a", "b"], leader: null, deleted: true }]);
    assert.deepEqual((await window.get("core.parties")).result, []);
    assert.equal((await window.run("core.card.get", { card: "a" })).party, null);
    assert.equal((await window.run("core.card.get", { card: "b" })).party, null);
  } finally {
    window.close();
  }
});
