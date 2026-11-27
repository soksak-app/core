// The notification surfaces of the window (docs/spec/notifications.md): the bell with the unread count, each of the three toast forms of
// the setting toastStyle (card, line and deck) with a notice that shows under the bell, and the notice center in both forms of the
// setting noticeCenterStyle (popover and drawer). The check sets each setting with core.settings.set, adds the notice with
// core.notices.add, waits on the status core.toasts or core.notices until the notice shows, reads the element rectangles, and takes a
// still of the window for each state, so the stills of Wails and Tauri can be compared by a person. It restores both settings and closes
// the notices it added when it ends. It runs in the final verification batch and is not part of the default check run.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { START_PLUGIN, fresh } from "./fixture.mjs";

const TOAST_FORMS = ["card", "line", "deck"];
const CENTER_FORMS = ["popover", "drawer"];

/** Takes a still of the window and returns its path, which the check reports so that the captures can be compared. */
async function still(s, t, name) {
  const { path } = await s.request("diagnostics.capture.still", {});
  t.diagnostic(`${name}: still ${path}`);
  return path;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the bell, the three toast forms and both notice center forms show their notices`, { timeout: 300000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.set", { patch: { toastStyle: "card", noticeCenterStyle: "popover" }, scope: "common" }));

    // The bell is the element core.chrome.notices and has a drawn size on this screen.
    const bell = await s.rect("core.chrome.notices", 0);
    assert.ok(bell.width > 0 && bell.height > 0, `the bell has no drawn size: ${JSON.stringify(bell)}`);
    await still(s, t, `${app.name} bell`);

    for (const form of TOAST_FORMS) {
      await s.run("core.settings.set", { patch: { toastStyle: form }, scope: "common" });
      // A warning of the plugin of the start tab is not a card notice, so it shows as a toast under the bell.
      const id = await s.run("core.notices.add", { plugin: START_PLUGIN, kind: "warning", title: `toast form ${form} check` });
      s.cleanup(() => s.run("core.notices.close", { id }));
      await s.until("core.toasts", (value) => value.toasts.some((toast) => toast.id === id),
        `the ${form} toast form did not show the notice`);
      await still(s, t, `${app.name} toast ${form}`);
      await s.run("core.notices.close", { id });
    }

    for (const form of CENTER_FORMS) {
      await s.run("core.settings.set", { patch: { noticeCenterStyle: form }, scope: "common" });
      const wasOpen = (await s.get("core.notices")).open;
      if (!wasOpen) await s.run("core.notices.toggle");
      await s.until("core.notices", (value) => value.open === true, `the ${form} notice center did not open`);
      const panel = await s.rect("core.notices.panel", 0);
      assert.ok(panel.width > 0 && panel.height > 0, `the ${form} notice center has no drawn size: ${JSON.stringify(panel)}`);
      await still(s, t, `${app.name} notice center ${form}`);
      await s.run("core.notices.toggle");
      await s.until("core.notices", (value) => value.open === false, `the ${form} notice center did not close`);
    }
  });
}
