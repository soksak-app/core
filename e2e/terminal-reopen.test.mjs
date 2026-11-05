// Checks that a terminal opened right after the earlier terminals closed displays the prompt of its shell.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { readScreenUntil } from "./terminal-screen.mjs";

const PROMPT = "sh-3.2$";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a terminal opened after the earlier terminals closed displays its prompt`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { cards } = await s.get("core.grid");
    const terminalCard = cards.find((item) => item.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(terminalCard, "the fixture has no terminal card");
    const card = terminalCard.id;
    // A tab of another plugin keeps the card open when its terminals close.
    await s.run("core.card.add-tab", { card, plugin: "browser" });
    for (let round = 0; round < 3; round++) {
      const tabs = [];
      for (let index = 0; index < 3; index++) {
        const { tab } = await s.run("core.card.add-tab", { card, plugin: "terminal" });
        tabs.push(tab);
        await s.until("terminal.session", (value) => value?.sessionId && value.cols > 0 && value.rows > 0,
          `round ${round}: terminal ${tab} did not open its session`, { surface: tab });
        await readScreenUntil(s, tab, (rows) => rows.some((line) => line.startsWith(PROMPT)),
          `round ${round}: terminal ${tab} did not display its prompt`);
      }
      for (const tab of tabs) {
        const closed = await s.run("core.tab.close", { tab });
        assert.equal(closed?.closed, true, `round ${round}: terminal ${tab} did not close`);
      }
      await s.until("core.surfaces", (items) => !items.some((item) => tabs.includes(item.surface)),
        `round ${round}: a closed terminal remained`);
    }
  });
}
