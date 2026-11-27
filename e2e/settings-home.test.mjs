// Checks that the settings tab comes to the front on the project home and shows its pane and menu (docs/spec/settings.md#opening-and-closing).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";

/** Whether a rect of s.rect has a visible area. */
const shown = (rect) => rect.width > 0 && rect.height > 0;

for (const app of Object.values(APPS)) {
  test(`${app.name}: the settings tab shows on the project home`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await keepCommonSettings(s);
    await s.run("core.projects.browse");
    await s.until("core.screen", (screen) => screen.screen === "home", "the project home did not show");
    await s.run("core.settings.open");
    s.cleanup(async () => {
      if ((await s.get("core.settings-tab")) !== null) await s.run("core.settings.close");
    });
    await s.until("core.settings-tab", (tab) => tab !== null, "settings did not open on the project home");
    const pane = await s.rect("core.settings-tab.pane");
    assert.ok(shown(pane), `the settings pane has no area on the project home: ${JSON.stringify(pane)}`);
    const find = await s.rect("core.settings-tab.find");
    assert.ok(shown(find), `the settings search has no area on the project home: ${JSON.stringify(find)}`);
    const nav = await s.rect("core.settings-tab.nav", 0);
    assert.ok(shown(nav), `the first settings menu item has no area on the project home: ${JSON.stringify(nav)}`);
  });
}
