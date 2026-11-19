// Red tests of the party colors of the theme (docs/spec/parties.md#drawing, docs/spec/parties.md#commands). Each theme declares the
// party colors party-1 to party-6 and the leader color party-leader in its dark and light palettes (parties.md:14). A new party takes
// the first color of party-1 to party-6 that its space does not use (parties.md:21), and a leader color that is null follows
// party-leader (parties.md:22). The tests read the declared theme of the shown theme name and mode.
import assert from "node:assert/strict";
import { test } from "node:test";
import { THEMES, value } from "../settings.js";
import { openPartyWindow } from "./support/party-window.mjs";

const TOKENS = ["party-1", "party-2", "party-3", "party-4", "party-5", "party-6", "party-leader"];
const HEX = /^#[0-9a-fA-F]{6}$/;
const shownPalette = () => THEMES.find((theme) => theme.name === value("theme"))[value("mode")];

test("each theme declares the six party colors and the leader color in both palettes (docs/spec/parties.md:14)", () => {
  for (const theme of THEMES) {
    for (const mode of ["dark", "light"]) {
      for (const token of TOKENS) {
        assert.match(theme[mode][token] ?? "", HEX, `${theme.name} ${mode} ${token} is a #rrggbb value`);
      }
    }
  }
});

test("a new party takes the color party-1 of the shown theme (docs/spec/parties.md:21)", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    const reply = await window.run("core.party.create", { cards: ["a", "b"] });
    assert.equal(reply.party.color, shownPalette()["party-1"], "the first party takes party-1 of the shown palette");
  } finally {
    window.close();
  }
});

test("a leader color that is null draws the color party-leader of the shown theme (docs/spec/parties.md:22)", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a", leaderColor: null });
    const border = document.querySelector('path[data-party-leader="p1"]');
    assert.ok(border, "the leader border is drawn");
    assert.equal(border.getAttribute("stroke"), shownPalette()["party-leader"], "the leader border takes party-leader of the shown palette");
  } finally {
    window.close();
  }
});
