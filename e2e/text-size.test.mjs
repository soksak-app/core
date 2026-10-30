// Checks that the text size command enlarges the text of the pressed card or frame and that the board stays inside the window (docs/spec/text-size.md).
// The command runs as an application menu item, so the path from the menu to the page command is checked as well.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

// The application menu is built from one ko/en table, so the check follows the menu language.
const TITLES = {
  ko: { menu: "보기", larger: "글자 크게", reset: "글자 기본 크기" },
  en: { menu: "View", larger: "Bigger Text", reset: "Default Text Size" },
};
const menuTitles = async (s) => {
  const menu = await s.get("host.menu");
  return TITLES[menu.language] ?? TITLES.en;
};

// The line height of a font is rounded to pixels, so an element size does not grow exactly by the scale. A size within 5% of the target scale
// counts as grown by that scale.
const grew = (before, after, factor) => Math.abs(after / before - factor) <= factor * 0.05;

/** Presses the center of a rectangle in document coordinates. */
async function press(s, rect) {
  const x = (rect.document?.x ?? 0) + rect.x + rect.width / 2;
  const y = (rect.document?.y ?? 0) + rect.y + rect.height / 2;
  await s.click(x, y);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: text size commands enlarge the pressed card or the frame and keep the plane in the window`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    s.cleanup(async () => {
      await s.run("core.settings.set", { patch: { textSize: 1 }, scope: "common" });
    });
    const grid = await s.get("core.grid");
    const terminalTab = grid.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(terminalTab, "the fixture has no terminal tab");
    await s.run("core.tab.select", { tab: terminalTab.id });
    const session = await s.until("terminal.session", (value) => value?.sessionId && value.cellHeight > 0 ? value : null,
      "the terminal session did not start", { surface: terminalTab.id });
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === terminalTab.id));
    await s.presented();

    // When a card is pressed, that card is the scope, and the menu item changes only the scale of that card.
    await press(s, await s.rect("terminal.view", undefined, terminalTab.id));
    await s.until("core.text", (value) => value.scope.kind === "card" && value.scope.card === card.id,
      "pressing the card did not make it the text size scope");
    const titles = await menuTitles(s);
    await s.run("host.menu.select", { menu: titles.menu, title: titles.larger });
    const cardText = await s.until("core.text", (value) => value.cards[card.id] === 1.1,
      "the menu item did not enlarge the pressed card");
    assert.equal(cardText.frame, 1, "enlarging a card must not change the frame factor");
    await s.presented();
    // A terminal measures its cells again with the font size of 13pt multiplied by the scale (docs/spec/text-size.md).
    const after = await s.until("terminal.session", (value) => value.cellHeight !== session.cellHeight ? value : null,
      "the terminal cell height did not change with the card factor", { surface: terminalTab.id });
    assert.ok(grew(session.cellHeight, after.cellHeight, 1.1),
      `the terminal cell height must grow by the card factor: ${session.cellHeight} → ${after.cellHeight}`);

    // The card scale is stored with the layout and stays after reading again.
    const documentBefore = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== documentBefore && doc.readyState === "complete",
      "the main document did not reload");
    await s.until("core.text", (value) => value.cards[card.id] === 1.1, "the card factor did not survive a reload");

    // When the frame is pressed, the frame is the scope, the space row grows, and the board stays inside the window.
    const window = await s.get("host.window");
    const spaceTab = await s.rect("core.space-tab", 0);
    const barBefore = await s.rect("core.chrome.bar");
    await press(s, spaceTab);
    await s.until("core.text", (value) => value.scope.kind === "frame", "pressing the frame did not make it the scope");
    // Raises three steps (1.1, 1.25, 1.5) from 1. Waits for the display at each step so that the page verification (V7b) judges whether the board and the native surface sit on the same device
    // pixel at that scale (F36).
    for (const factor of [1.1, 1.25, 1.5]) {
      await s.run("host.menu.select", { menu: titles.menu, title: titles.larger });
      await s.until("core.text", (value) => value.frame === factor, `the frame factor did not reach ${factor}`);
      await s.presented();
    }
    await s.until("core.text", (value) => value.frame === 1.5, "three frame steps did not reach factor 1.5");
    await s.presented();
    // The first row is outside the CSS zoom subtree, so its rectangle is in document pixels on every engine, and its height is
    // round(max(40, 36 × frame factor)) (docs/spec/text-size.md). The rectangle of the space tab is inside the subtree, and WebKit
    // before 7624 reports it divided by the zoom, so the tab is judged by its effective zoom, which every engine reports.
    const barAfter = await s.rect("core.chrome.bar");
    const spaceAfter = await s.rect("core.space-tab", 0);
    assert.equal(barBefore.height, 40, `the first row must be 40 px at factor 1: ${barBefore.height}`);
    assert.equal(barAfter.height, Math.round(Math.max(40, 36 * 1.5)),
      `the first row must follow the frame factor 1.5: ${barBefore.height} → ${barAfter.height}`);
    assert.equal(spaceTab.zoom, 1, `the space tab zoom must be 1 at factor 1: ${spaceTab.zoom}`);
    assert.equal(spaceAfter.zoom, 1.5, `the space tab zoom must follow the frame factor 1.5: ${spaceAfter.zoom}`);
    const cardRect = await s.rect("core.card", 0);
    assert.ok(cardRect.y + cardRect.height <= window.content.height + 0.5,
      `the plane must stay inside the window: card bottom ${cardRect.y + cardRect.height}, content ${window.content.height}`);

    // The default size returns the current scope (the frame) to 1.
    await s.run("host.menu.select", { menu: titles.menu, title: titles.reset });
    await s.until("core.text", (value) => value.frame === 1 && value.cards[card.id] === 1.1,
      "restoring the frame must not change the card factor");
  });
}
