// Red test of the split rule when the space order is reversed (docs/spec/parties.md#changes-of-the-layout). The space stores the cards
// e d c b a. Without a leader and with equal counts, the split keeps the part whose first card comes first in the space order, which
// is the part d e here, because e is the first card of the space. The party module and the party commands do not exist yet, so the
// test fails on the unchanged implementation at its first command.
import assert from "node:assert/strict";
import test from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

test("with equal counts the part whose first card is earlier in a reversed space order stays", { timeout: 10000 }, async () => {
  const window = await openPartyWindow(["e", "d", "c", "b", "a"]);
  await window.reset();
  await window.run("core.party.create", { cards: ["a", "b", "c", "d", "e"] });
  await window.run("core.party.remove", { party: "p1", card: "c" });
  assert.deepEqual([...(await window.run("core.party.get", { party: "p1" })).cards].sort(), ["d", "e"]);
});
