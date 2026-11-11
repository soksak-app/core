// Checks that a press on the notice of a tab out of view selects that tab, with the press that the host emulates inside the
// application. The tab is one of the start plugin, which takes a notice through its notify command.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, START_PLUGIN } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: clicking a tab notice of a tab out of view selects its tab`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const cardOf = (grid, surface) => grid.cards.find((card) => card.tabs.some((tab) => tab.id === surface));
    const start = (await s.get("core.grid")).cards.find((card) => card.focused);
    if (!start) throw new Error("the start layout has no focused card");
    const shown = start.active;
    const { tab: hidden } = await s.run("core.card.add-tab", { card: start.id, plugin: START_PLUGIN });
    s.cleanup(() => s.run("core.tab.close", { tab: hidden }));
    await s.registered(hidden, [`command ${START_PLUGIN}.notify`]);
    await s.run("core.tab.select", { tab: shown });
    await s.until("core.grid", (grid) => cardOf(grid, shown).active === shown && cardOf(grid, shown).focused,
      "the first tab did not return to view in its focused card");
    await s.run(`${START_PLUGIN}.notify`, { text: "PRESS-NOTICE", policy: "tab" }, hidden);
    await s.until("core.grid", (grid) => cardOf(grid, hidden).tabs.find((item) => item.id === hidden).notice === "PRESS-NOTICE",
      "the tab out of view did not show a tab notice");
    const index = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).findIndex((item) => item.id === hidden);
    if (index < 0) throw new Error("the tab out of view is not rendered");
    const tab = await s.rect("core.card.tab", index);
    await s.click(tab.document.x + tab.x + tab.width / 2, tab.document.y + tab.y + tab.height / 2);
    await s.until("core.grid", (now) => cardOf(now, hidden).active === hidden,
      "clicking the tab notice did not select its tab");
    await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), hidden).id });
    await s.until("core.grid", (now) => cardOf(now, hidden).focused,
      "the selected tab's card did not take focus");
  });
}
