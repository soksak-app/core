// A person presses a tab and types at once. The keys that follow the release of the press reach the image region of the tab whole,
// because the window holds its input from the release until the workbench decided where the keyboard goes
// (docs/spec/native-surfaces.md#keyboard-of-a-surface). The tabs are those of the raster probe, whose `rasterprobe.input` logs each
// input transaction of its image region with the echo of its sidecar. The window takes the press and the keys as the virtual key
// window and each key states its text, so the application and the input source of the person stay as they are
// (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { assertReceivedUnchanged, lastTransaction, rasterProbeTab, readyRasterProbe, receivedAfter, tabElementIndex, typedText } from "./input-probe.mjs";

const TYPED = "echo tabpress\n";
// The keys of the hold and of the keyboard, so that a failure names where the keys stopped.
const READS = ["native.surface.key_kept", "native.surface.keys_delivered", "native.surface.keys_dropped",
  "native.window.first_responder", "native.input.key_down"];

for (const app of Object.values(APPS)) {
  test(`${app.name}: keys typed right after a press on a tab reach its image region whole`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s, { log: { input: "debug" }, reads: READS });
    const { surface: first, card } = await rasterProbeTab(s);
    const { surface: second } = await rasterProbeTab(s, { card });
    await s.run("core.tab.select", { tab: first });
    await readyRasterProbe(s, first);
    await s.until("core.grid", (now) => now.cards.find((item) => item.id === card)?.active === first,
      "the first tab did not become active");
    const start = await lastTransaction(s, second);
    // The tab elements are numbered across every card, and the raster probes are in the focused card, after the tabs of the cards
    // before it.
    const rect = await s.rect("core.card.tab", tabElementIndex(await s.get("core.grid"), second));
    const x = (rect.document?.x ?? 0) + rect.x + rect.width / 2, y = (rect.document?.y ?? 0) + rect.y + rect.height / 2;
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(x, y, "move");
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    await s.pointer(x, y, "down");
    await s.pointer(x, y, "up");
    // No wait: a person types as the button comes up.
    for (const key of TYPED) {
      const [name, options] = key === "\n" ? ["Enter", {}] : [key === " " ? "Space" : key, { text: key }];
      await s.key(name, "down", options);
      await s.key(name, "up", options);
    }
    await s.until("core.grid", (now) => now.cards.find((item) => item.id === card)?.active === second,
      "the press did not select the tab");
    await s.until("rasterprobe.input", (input) => typedText(input.log.filter((entry) => entry.sequence > start)) === TYPED,
      `the keys of ${JSON.stringify(TYPED)} did not reach the tab whole and in order`, { surface: second });
    const log = await receivedAfter(s, second, start, "the sidecar did not echo the input transactions");
    assertReceivedUnchanged(log, `${app.name} tab press keys`);
    assert.equal(typedText(log), TYPED);
  });
}
