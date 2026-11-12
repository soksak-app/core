// Checks the footer text of a card.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  // The content foot of a card shows the bottom text that the plugin of the active tab reports (docs/spec/plugins.md#tab-reports):
  // the footer that the layout probe declares at its start, and a footer that it reports later.
  test(`${app.name}: the content footer shows the footer text that the active tab's plugin reports`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    const { footer } = await s.get("layoutprobe.view", surface);
    const shows = async (text, message) => {
      const grid = await s.until("core.grid", (value) => {
        const card = value.cards.find((item) => item.tabs?.some((tab) => tab.id === surface));
        return card?.active === surface && card.tabs.find((tab) => tab.id === surface)?.footer === text;
      }, message);
      const card = grid.cards.find((item) => item.tabs?.some((tab) => tab.id === surface));
      assert.equal(card.status, text, `the card footer does not show the footer of its active tab: ${JSON.stringify(card)}`);
    };
    assert.ok(footer, "the layout probe declared no footer at its start");
    await shows(footer, "the probe tab did not report its start footer");
    const reported = `footer ${surface}`;
    await s.run("layoutprobe.footer", { text: reported }, surface);
    await shows(reported, "the probe tab did not report its later footer");
  });
}
