// Checks that a press on the plane of the key window closes the open picker, as a person's press does. A press of a key window
// passes the application, so the host that closes the picker from a local monitor sees it; a press of the virtual key window passes
// -[NSApplication sendEvent:] as well (docs/spec/exposure.md#virtual-key-window), so the check presses the plane of a covered window
// of an application that is not active.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a press on the plane of the key window closes the add picker`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.pane === 0);
    await s.run("core.card.menu", { card: card.id, menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the add picker did not open");
    // The picker hangs from the head of the card, so the bottom of the card is outside it.
    const x = grid.plane.x + card.x + card.w / 2;
    const y = grid.plane.y + card.y + card.h - 24;
    await s.pointer(x, y, "move", { activate: true });
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    await s.pointer(x, y, "down");
    await s.pointer(x, y, "up");
    await s.until("core.picker", (picker) => !picker.open, "a press on the plane did not close the add picker");
  });
}
