// Red test of the refusal of a window sidebar in a party (docs/spec/parties.md#commands). The card left is the window sidebar of the left
// side (docs/spec/external-sidebars.md), which a party does not hold. The party module and the party commands do not exist yet, so the
// test fails on the unchanged implementation at its first command.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { openPartyWindow } from "./support/party-window.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/party-window-sidebar.json", import.meta.url), "utf8"));

test("core.party.create that lists a window sidebar is refused with card <id> is a window sidebar", { timeout: 10000 }, async () => {
  const window = await openPartyWindow(fixture.cards);
  await window.reset();
  await assert.rejects(window.run("core.party.create", { cards: ["left", "a"] }), /^Error: card left is a window sidebar$/);
  assert.deepEqual((await window.get("core.parties")).result, []);
});
