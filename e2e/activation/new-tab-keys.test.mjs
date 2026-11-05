// A person types as soon as a new tab opens. The keys that come before the terminal of the tab can take them reach it whole.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { echoed, readScreenUntil } from "../terminal-screen.mjs";

const MARKER = "newtabkeys";

for (const app of Object.values(APPS)) {
  test(`${app.name}: keys typed as a new tab opens reach its terminal whole`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // A person's window is in front; a pointer move that presses nothing activates it.
    const adding = await s.request("element.rect", { name: "core.space-tab.add" });
    await s.pointer(adding.x + adding.width / 2, adding.y + adding.height / 2, "move", { activate: true });
    await s.until("host.window", (state) => state.active && state.key, "the window did not become key");
    const card = (await s.get("core.grid")).cards.find((item) => !item.fixed && item.tabs?.length).id;
    const { tab } = await s.run("core.card.add-tab", { card, plugin: "terminal" });
    // No wait for the view: the reply of the call is the first moment a person could know that the tab opened.
    for (const key of [..."echo ", ...MARKER, "Enter"]) {
      const name = key === " " ? "Space" : key;
      await s.key(name, "down");
      await s.key(name, "up");
    }
    // A ready view registers its commands after it reports ready, and the screen is read through one of them.
    await s.until("core.surfaces", (list) => list.some((entry) => entry.surface === tab && entry.status?.phase === "ready"
      && entry.exposes.includes("command terminal.screen.read")), "the terminal of the tab did not register its screen read");
    const lines = await readScreenUntil(s, tab, (rows) => echoed(rows, MARKER), `the keys of ${MARKER} did not reach the terminal whole`);
    assert.ok(echoed(lines, MARKER));
  });
}
