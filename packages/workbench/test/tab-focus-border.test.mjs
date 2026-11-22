// The active tab of the focused card draws its border in the focus color of the ring of the card, and the active tab of another card
// draws none, so the keyboard, the ring and the tab border show one focus (docs/spec/example-model.md#card-tabs).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the active tab of the focused card takes the focus border, and another card's active tab takes none", { timeout: 5000 }, async () => {
  const css = await readFile(new URL("../app.css", import.meta.url), "utf8");
  const card = (focused) => `<article class="card" data-focused="${focused}"><header class="chrome"><div class="tab" data-active="true"></div>` +
    `<div class="tab" data-active="false"></div></header></article>`;
  const dom = new JSDOM(`<style>${css}</style>${card(true)}${card(false)}`);
  try {
    const [ringed, inactive, other] = [...dom.window.document.querySelectorAll(".tab")].filter((_, i) => i !== 3);
    const shadow = (el) => dom.window.getComputedStyle(el).boxShadow;
    assert.match(shadow(ringed), /var\(--focus\)/, "the active tab of the focused card has no border in the focus color");
    assert.doesNotMatch(shadow(inactive), /var\(--focus\)/, "an inactive tab of the focused card takes the focus border");
    assert.doesNotMatch(shadow(other), /var\(--focus\)/, "the active tab of another card takes the focus border");
  } finally {
    dom.window.close();
  }
});
