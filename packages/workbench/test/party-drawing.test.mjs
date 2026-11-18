// Red tests of the drawn party outline, the leader border and the rail (docs/spec/parties.md#drawing). The element names are the ones the
// specification names: the outline is path[data-party="<id>"], the leader border is path[data-party-leader="<id>"] with its stroke, and the
// rail is #railPath. The party module and the party commands do not exist yet, so the test fails on the unchanged implementation at its
// first command.
import assert from "node:assert/strict";
import test from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

test("the outer outline of a party is one closed path element named by the party", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const outline = document.querySelectorAll('path[data-party="p1"]');
    assert.equal(outline.length, 1, "the party has one outline path");
    assert.match(outline[0].getAttribute("d"), /Z\s*$/, "the outline path is closed");
  } finally {
    window.close();
  }
});

test("the leader border of a party is drawn in the leader color", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a", leaderColor: "#123456" });
    const border = document.querySelectorAll('path[data-party-leader="p1"]');
    assert.equal(border.length, 1, "the leader border is drawn");
    assert.equal(border[0].getAttribute("stroke"), "#123456");
  } finally {
    window.close();
  }
});

test("the party outline and the rail do not coincide when they overlap", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const outline = document.querySelector('path[data-party="p1"]');
    const rail = document.getElementById("railPath");
    assert.ok(outline && rail, "both paths are drawn");
    assert.notEqual(outline.getAttribute("d"), rail.getAttribute("d"), "the rail and the party outline have the same path");
  } finally {
    window.close();
  }
});
