// Red tests of take (docs/spec/parties.md#take). core.party.add with take: true and the party module are absent, so each test fails
// on the unchanged implementation at the first command. The rows are the rules of the specification: a card moves in one command,
// the target is judged after the move, and a former party that keeps fewer than 2 cards is deleted.
import assert from "node:assert/strict";
import test from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

test("core.party.add with take moves the card from its former party and reports the move in taken", { timeout: 10000 }, async () => {
  // a b c d e: p1 holds a, b, c and p2 holds d, e. Card c touches d, so it moves to p2 and p1 keeps a and b.
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b", "c"] });
    await window.run("core.party.create", { cards: ["d", "e"] });
    const reply = await window.run("core.party.add", { party: "p2", card: "c", take: true });
    assert.deepEqual(reply.taken, [{ card: "c", from: "p1" }]);
    assert.deepEqual(reply.party.cards, ["c", "d", "e"]);
    assert.deepEqual((await window.run("core.party.get", { party: "p1" })).cards, ["a", "b"]);
    assert.equal((await window.run("core.card.get", { card: "c" })).party, "p2");
  } finally {
    window.close();
  }
});

test("a take that leaves the former party with fewer than 2 cards deletes that party and keeps its card in the layout", { timeout: 10000 }, async () => {
  // a b: p1 holds a and b, p2 holds c and d. Card b moves to p2, p1 keeps only a and is deleted.
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    await window.run("core.party.create", { cards: ["c", "d"] });
    const reply = await window.run("core.party.add", { party: "p2", card: "b", take: true });
    assert.deepEqual(reply.taken, [{ card: "b", from: "p1" }]);
    assert.deepEqual([...reply.changed].sort((x, y) => x.party.localeCompare(y.party)), [
      { party: "p1", removed: ["b"], leader: null, deleted: true },
      { party: "p2", removed: [], leader: null, deleted: false },
    ]);
    await assert.rejects(window.run("core.party.get", { party: "p1" }), /^Error: unknown party p1$/);
    assert.equal((await window.run("core.card.get", { card: "a" })).party, null);
  } finally {
    window.close();
  }
});

test("a take of a card that does not touch the target is refused and nothing moves", { timeout: 10000 }, async () => {
  // a b c d e: p1 holds a and b, p2 holds d and e. Card b does not touch d, so the take is refused.
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    await window.run("core.party.create", { cards: ["d", "e"] });
    await assert.rejects(window.run("core.party.add", { party: "p2", card: "b", take: true }), /^Error: cards are not touching: /);
    assert.deepEqual((await window.run("core.party.get", { party: "p1" })).cards, ["a", "b"]);
    assert.deepEqual((await window.run("core.party.get", { party: "p2" })).cards, ["d", "e"]);
  } finally {
    window.close();
  }
});

test("a take of the leader leaves the former party without a leader and keeps its color", { timeout: 10000 }, async () => {
  // a b c d e: p1 holds a, b, c with leader c; p2 holds d, e. Card c touches d and moves to p2.
  const window = await openPartyWindow();
  try {
    await window.reset();
    const former = await window.run("core.party.create", { cards: ["a", "b", "c"], leader: "c" });
    await window.run("core.party.create", { cards: ["d", "e"] });
    const reply = await window.run("core.party.add", { party: "p2", card: "c", take: true });
    assert.deepEqual(reply.changed.find((row) => row.party === "p1"), { party: "p1", removed: ["c"], leader: null, deleted: false });
    const remaining = await window.run("core.party.get", { party: "p1" });
    assert.equal(remaining.leader, null);
    assert.equal(remaining.color, former.party.color);
  } finally {
    window.close();
  }
});

test("the party that a take joins reports the reason taken", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b", "c"] });
    await window.run("core.party.create", { cards: ["d", "e"] });
    await window.run("core.party.add", { party: "p2", card: "c", take: true });
    assert.equal((await window.run("core.party.get", { party: "p2" })).reason, "taken");
  } finally {
    window.close();
  }
});
