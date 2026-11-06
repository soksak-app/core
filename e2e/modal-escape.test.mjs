// Checks that the native Escape of the key window reaches the picker: its document on a host with a main page, and the picker
// that the host draws itself on a host without one. The window takes the keys as the virtual key window, so the application of
// the person keeps the keyboard (docs/spec/exposure.md#virtual-key-window).
import test from "node:test";

import { APPS, MAIN_PAGE_APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

for (const app of MAIN_PAGE_APPS) {
  test(`${app.name}: the key window closes its add picker with native Escape`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.pane === 0).id;
    await s.run("core.card.menu", { card, menu: "add" });
    const window = await s.until("host.window", (state) => state.modal?.id === "picker" && state.modal.shown,
      "the add picker did not appear");
    const rect = window.modal.frame;
    await s.pointer(rect.x + rect.width / 2, rect.y + rect.height / 2, "move");
    await s.until("host.window", (state) => state.virtualKey,
      "the picker window did not become the virtual key window");
    await s.press("Escape");
    await s.until("host.window", (state) => state.modal === null,
      "native Escape did not close the add picker in the key window");
  });
}

for (const app of Object.values(APPS).filter((item) => !MAIN_PAGE_APPS.includes(item))) {
  test(`${app.name}: the key window closes the add picker it draws with native Escape`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.pane === 0);
    await s.run("core.card.menu", { card: card.id, menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the add picker did not open");
    await s.pointer(grid.plane.x + card.x + card.w / 2, grid.plane.y + card.y + card.h - 24, "move");
    await s.until("host.window", (state) => state.virtualKey,
      "the window did not become the virtual key window");
    await s.press("Escape");
    await s.until("core.picker", (picker) => !picker.open, "native Escape did not close the add picker");
  });
}
