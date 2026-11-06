// A person types as soon as a new tab opens. The keys that come before the terminal of the tab can take them reach it whole.
// The window takes the keys as the virtual key window and each key states its text, so the application and the input source of
// the person stay as they are (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { echoed, readScreenUntil } from "./terminal-screen.mjs";

const MARKER = "newtabkeys";
// The keys that the surface keeps and gives to its region, and where the keyboard went, so that a failure names where the keys
// stopped.
const READS = ["native.surface.key_kept", "native.surface.keys_delivered", "native.surface.keys_dropped",
  "native.window.first_responder", "native.input.key_down"];

for (const app of Object.values(APPS)) {
  test(`${app.name}: keys typed as a new tab opens reach its terminal whole`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { input: "debug" }, reads: READS });
    // A pointer move that presses nothing makes the window the virtual key window.
    const adding = await s.request("element.rect", { name: "core.space-tab.add" });
    await s.pointer(adding.x + adding.width / 2, adding.y + adding.height / 2, "move");
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    const card = (await s.get("core.grid")).cards.find((item) => !item.fixed && item.tabs?.length).id;
    const { tab } = await s.run("core.card.add-tab", { card, plugin: "terminal" });
    // No wait for the view: the reply of the call is the first moment a person could know that the tab opened.
    for (const key of [..."echo ", ...MARKER, "Enter"]) {
      const [name, options] = key === "Enter" ? [key, {}] : [key === " " ? "Space" : key, { text: key }];
      await s.key(name, "down", options);
      await s.key(name, "up", options);
    }
    // A ready view registers its commands after it reports ready, and the screen is read through one of them.
    await s.until("core.surfaces", (list) => list.some((entry) => entry.surface === tab && entry.status?.phase === "ready"
      && entry.exposes.includes("command terminal.screen.read")), "the terminal of the tab did not register its screen read");
    const lines = await readScreenUntil(s, tab, (rows) => echoed(rows, MARKER), `the keys of ${MARKER} did not reach the terminal whole`);
    assert.ok(echoed(lines, MARKER));
  });
}
