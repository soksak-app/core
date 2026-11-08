// Narrow card head: tab list on the left, current tab title in the center, tools menu on the right (docs/features.md F81).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const card = (grid, id) => grid.cards.find((item) => item.id === id);
/** The card of the grid that holds the tab surface. */
const cardOf = (grid, surface) => grid.cards.find((item) => item.tabs?.some((tab) => tab.id === surface)).id;

for (const app of Object.values(APPS)) {
  test(`${app.name}: a narrow card folds its tools into a menu that runs them and keeps its title`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const { surface, plugin } = await fresh(s);
    const own = cardOf(await s.get("core.grid"), surface);
    const born = (await s.run("core.card.split", { card: own, side: "right", plugin })).card;
    await s.until("core.grid", (grid) => card(grid, born), "the split did not add a card");
    const layout = await s.get("core.layout");
    const lines = layout.state.cards.find((item) => item.id === own);
    const grid = await s.get("core.grid");
    // Narrows the start card to 130pt. At this width five tools and the title do not fit on one line.
    await s.run("core.boundary.move", { axis: "x", line: lines.c1, position: grid.lines.x[lines.c0] + 136 });
    const narrow = await s.until("core.grid", (value) => card(value, own).w <= 140 && card(value, own).acts?.tools === "menu",
      "the narrow card did not fold its tools into the menu");
    const acts = card(narrow, own).acts;
    assert.equal(acts.fit, "one", `the narrow card does not keep its title: ${JSON.stringify(acts)}`);

    // Pressing the tools menu button natively opens the menu, and its items run the commands of the tools.
    const index = narrow.cards.filter((item) => item.pane !== null).findIndex((item) => item.id === own);
    const button = await s.rect("core.card.tools", index);
    assert.ok(button.width > 0 && button.height > 0, `the tool menu button is not shown: ${JSON.stringify(button)}`);
    await s.click((button.document?.x ?? 0) + button.x + button.width / 2, (button.document?.y ?? 0) + button.y + button.height / 2);
    const menu = await s.until("core.picker", (picker) => picker.open, "the tool menu did not open");
    const keys = menu.items.map((item) => item.key);
    for (const key of ["add", "fullscreen", "close"]) assert.ok(keys.includes(key), `the tool menu lacks ${key}: ${JSON.stringify(keys)}`);
    await s.run("core.picker.pick", { index: keys.indexOf("close") });
    await s.until("core.grid", (value) => !card(value, own), "the close item did not close the card");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the tab list button of a card shows at every width of its head`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    const grid = await s.get("core.grid");
    const own = cardOf(grid, surface);
    const index = grid.cards.filter((item) => item.pane !== null).findIndex((item) => item.id === own);
    assert.equal(card(grid, own).acts?.fit, "strip", `the fixture card does not show all its tabs: ${JSON.stringify(card(grid, own).acts)}`);
    const button = await s.rect("core.card.tab-list", index);
    assert.ok(button.width > 0 && button.height > 0, `the tab list button is not shown in a card that shows all its tabs: ${JSON.stringify(button)}`);
  });
}
