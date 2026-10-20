// Space app list and switching of a full-screen card (docs/spec/example-model.md#card-fullscreen).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

const card = (grid, id) => grid.cards.find((item) => item.id === id);
const panes = (grid) => grid.cards.filter((item) => item.pane !== null);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a fullscreen card lists the apps of the space by card and switches to a picked one`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // Adds one more tab of B to the layout A | (B / C). A is the terminal card of the fixture.
    const start = panes(await s.get("core.grid"));
    for (const extra of start.filter((item) => item.id !== "terminal")) await s.run("core.card.close", { card: extra.id });
    const b = (await s.run("core.card.split", { card: "terminal", side: "right", plugin: "browser" })).card;
    const c = (await s.run("core.card.split", { card: b, side: "bottom", plugin: "browser" })).card;
    await s.run("core.card.add-tab", { card: b, plugin: "terminal" });
    const grid = await s.until("core.grid", (value) => card(value, b)?.tabs.length === 2 && card(value, c),
      "the arrangement A | (B / C) did not appear");

    await s.run("core.card.fullscreen", { card: "terminal" });
    await s.until("core.grid", (value) => value.fullscreen === "terminal", "the card did not become fullscreen");
    // The button is at the very front of the full-screen card header.
    const index = panes(grid).findIndex((item) => item.id === "terminal");
    const button = await s.rect("core.card.space-apps", index);
    const tab = await s.rect("core.card.tab", 0);
    assert.ok(button.width > 0 && button.x < tab.x, `the space apps button is not at the front: ${JSON.stringify({ button, tab })}`);
    await s.click((button.document?.x ?? 0) + button.x + button.width / 2, (button.document?.y ?? 0) + button.y + button.height / 2);
    const menu = await s.until("core.picker", (picker) => picker.open, "the space apps list did not open");
    assert.match(menu.title, /^스페이스 앱 4개$/);
    assert.deepEqual(menu.items.map((item) => item.group), ["terminal", b, b, c],
      `the groups do not follow the arrangement: ${JSON.stringify(menu.items)}`);
    assert.equal(menu.items.find((item) => item.active)?.group, "terminal");

    // A title and an item of the same depth have the same icon x and the same name x (the title follows the groups order of core.picker and the item follows the items order).
    // The check environment cannot create a tab of a plugin that is not loaded, so only the items of loaded plugins are measured.
    assert.deepEqual(menu.groups.map((group) => group.id), ["terminal", b, c],
      `the headings do not follow the arrangement: ${JSON.stringify(menu.groups)}`);
    // The selection layer is hidden from the main document while the native view draws, so the columns are measured when opened and reported as columns of core.picker.
    assert.equal(menu.columns.items.length, menu.items.length);
    assert.equal(menu.columns.groups.length, menu.groups.length);
    for (const [at, item] of menu.items.entries()) {
      const heading = menu.groups.findIndex((group) => group.id === item.group);
      const itemBox = menu.columns.items[at];
      const headingBox = menu.columns.groups[heading];
      assert.equal(itemBox.icon, headingBox.icon, `${item.key}: the icon x differs from the heading icon x at depth ${menu.groups[heading].depth}`);
      assert.equal(itemBox.name, headingBox.name, `${item.key}: the name x differs from the heading name x at depth ${menu.groups[heading].depth}`);
    }

    // Choosing the tab of C moves the full screen to C and shows that tab.
    const target = menu.items.findIndex((item) => item.group === c);
    await s.run("core.picker.pick", { index: target });
    const moved = await s.until("core.grid", (value) => value.fullscreen === c, "fullscreen did not move to the picked card");
    assert.equal(card(moved, c).active, menu.items[target].key.split("/")[1]);
    for (const item of panes(moved)) assert.equal(item.fullscreen, item.id === c, `${item.id} fullscreen ${item.fullscreen}`);

    await s.run("core.card.fullscreen", { card: c });
    await s.until("core.grid", (value) => value.fullscreen === null, "fullscreen did not end");
  });
}
