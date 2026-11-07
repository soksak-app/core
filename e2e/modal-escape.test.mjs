// Checks that the native Escape of the key window reaches the picker: its document on a host with a main page, and the picker
// that the host draws itself on a host without one. The window takes the keys as the virtual key window, so the application of
// the person keeps the keyboard (docs/spec/exposure.md#virtual-key-window).
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

// A host with a main page (`pageProcess` of `host.window`) shows the picker in a modal window that becomes the virtual key window under the pointer; a host
// without one draws the picker in the window itself, which becomes the virtual key window under the pointer over the card.
for (const app of Object.values(APPS)) {
  test(`${app.name}: the key window closes its add picker with native Escape`, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s);
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.pane === 0);
    await s.run("core.card.menu", { card: card.id, menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the add picker did not open");
    if ((await s.get("host.window")).pageProcess !== null) {
      const shown = await s.until("host.window", (state) => state.modal?.id === "picker" && state.modal.shown,
        "the add picker window did not appear");
      const rect = shown.modal.frame;
      await s.pointer(rect.x + rect.width / 2, rect.y + rect.height / 2, "move");
    } else {
      await s.pointer(grid.plane.x + card.x + card.w / 2, grid.plane.y + card.y + card.h - 24, "move");
    }
    await s.until("host.window", (state) => state.virtualKey,
      "the window of the picker did not become the virtual key window");
    await s.press("Escape");
    await s.until("core.picker", (picker) => !picker.open, "native Escape did not close the add picker");
    await s.until("host.window", (state) => state.modal === null, "the add picker window stayed after native Escape");
  });
}
