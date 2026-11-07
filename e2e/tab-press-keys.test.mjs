// A person presses a tab and types at once. The keys that follow the release of the press reach the terminal of the tab whole,
// because the window holds its input from the release until the workbench decided where the keyboard goes
// (docs/spec/native-surfaces.md#keyboard-of-a-surface). The window takes the press and the keys as the virtual key window and
// each key states its text, so the application and the input source of the person stay as they are
// (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { echoed, readScreenUntil } from "./terminal-screen.mjs";

const MARKER = "tabpress";
// The keys of the hold and of the keyboard, so that a failure names where the keys stopped.
const READS = ["native.surface.key_kept", "native.surface.keys_delivered", "native.surface.keys_dropped",
  "native.window.first_responder", "native.input.key_down"];

// Waits until the terminal of tab registered its screen read.
async function readyTerminal(s, tab) {
  await s.until("core.surfaces", (list) => list.some((entry) => entry.surface === tab && entry.status?.phase === "ready"
    && entry.exposes.includes("command terminal.screen.read")), `the terminal of ${tab} did not register its screen read`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: keys typed right after a press on a tab reach its terminal whole`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s, { log: { input: "debug" }, reads: READS });
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => !item.fixed && item.tabs?.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "the fixture has no card with a terminal tab");
    const first = card.tabs.find((tab) => tab.plugin === "terminal").id;
    const { tab: second } = await s.run("core.card.add-tab", { card: card.id, plugin: "terminal" });
    await readyTerminal(s, second);
    await s.run("core.tab.select", { tab: first });
    await readyTerminal(s, first);
    await s.until("core.grid", (now) => now.cards.find((item) => item.id === card.id)?.active === first,
      "the first tab did not become active");
    const index = (await s.get("core.grid")).cards.find((item) => item.id === card.id).tabs.findIndex((tab) => tab.id === second);
    const rect = await s.rect("core.card.tab", index);
    const x = (rect.document?.x ?? 0) + rect.x + rect.width / 2, y = (rect.document?.y ?? 0) + rect.y + rect.height / 2;
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(x, y, "move");
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    await s.pointer(x, y, "down");
    await s.pointer(x, y, "up");
    // No wait: a person types as the button comes up.
    for (const key of [..."echo ", ...MARKER, "Enter"]) {
      const [name, options] = key === "Enter" ? [key, {}] : [key === " " ? "Space" : key, { text: key }];
      await s.key(name, "down", options);
      await s.key(name, "up", options);
    }
    await s.until("core.grid", (now) => now.cards.find((item) => item.id === card.id)?.active === second,
      "the press did not select the tab");
    const lines = await readScreenUntil(s, second, (rows) => echoed(rows, MARKER), `the keys of ${MARKER} did not reach the tab whole`);
    assert.ok(echoed(lines, MARKER));
  });
}
