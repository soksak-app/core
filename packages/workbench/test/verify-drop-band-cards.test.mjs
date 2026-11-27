import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { headedAndFootedCards } from "../verify-checks.js";

// A window sidebar draws its head and its set and no status line (docs/spec/external-sidebars.md#sidebar-head-and-edge), so the
// drop band check of the verification measures only the cards that draw both a head and a foot.
test("the drop band check measures a card that draws a head and a foot and skips a window sidebar", () => {
  const dom = new JSDOM(
    '<body><div class="plane">' +
      '<article class="card" data-card-id="content"><header class="chrome"></header><div class="slot"></div><footer class="status"></footer></article>' +
      '<article class="card" data-card-id="left"><header class="chrome sidebar-head"></header><div class="set"></div></article>' +
    "</div></body>",
  );
  const measured = headedAndFootedCards(dom.window.document.querySelector(".plane"));
  assert.deepEqual(measured.map((el) => el.dataset.cardId), ["content"]);
});
