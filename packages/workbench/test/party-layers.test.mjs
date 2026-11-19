// Red test of the stacking of the party layer (docs/spec/parties.md#drawing). The mygo host paints the party lines over the cards of the
// stage and the rail over them (drawRail of packages/workbench-mygo/src/shell_statuses.go, in DrawOver of the stage). On the page the
// party layer must stack the same way: above every card that the rail layer stacks above, and below the rail layer. At the seam, where
// the gap is the border width, the party band lies on the edges of the cards, and a party layer under a card would hide it there. JSDOM
// computes no layout, so the test compares the computed z-index of the layers in the stacking context of the plane, with the stylesheet
// of the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

const stack = (element) => Number.parseInt(getComputedStyle(element).zIndex, 10) || 0;

// contract: workbench.parties.drawing
test("the party layer stacks above every card that the rail stacks above and below the rail", { timeout: 10000 }, async () => {
  const window = await openPartyWindow(["a", "b", "right"], { overrides: true });
  // JSDOM does not load the stylesheet link of index.html, so the test adds the stylesheet of the page.
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  document.head.append(style);
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a" });
    const layer = document.querySelector('path[data-party="p1"]')?.ownerSVGElement;
    assert.ok(layer, "the party layer is drawn");
    const plane = document.getElementById("plane");
    const rail = document.getElementById("rail");
    assert.equal(layer.parentElement, plane, "the party layer is not a child of the plane");
    const cards = [...plane.querySelectorAll(".card")];
    assert.ok(cards.length >= 2, `the plane holds ${cards.length} card elements`);
    assert.ok(stack(rail) > stack(layer), `the rail layer (z-index ${stack(rail)}) is not above the party layer (z-index ${stack(layer)})`);
    const covered = cards.filter((card) => stack(rail) > stack(card) && stack(layer) <= stack(card))
      .map((card) => ({ card: card.dataset.cardId ?? card.id, zIndex: stack(card) }));
    assert.deepEqual(covered, [], `cards that stack over the party layer (z-index ${stack(layer)}) and under the rail (z-index ${stack(rail)})`);
  } finally {
    window.close();
  }
});
