// A person types as soon as a new tab opens. The keys that come before the image region of the tab can take them reach it whole.
// The tab is one of the raster probe, whose `rasterprobe.input` logs each input transaction of its image region with the echo of
// its sidecar. The window takes the keys as the virtual key window and each key states its text, so the application and the input
// source of the person stay as they are (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { assertReceivedUnchanged, focusedCard, RASTER_PROBE, readyRasterProbe, receivedAfter, typedText } from "./input-probe.mjs";

const TYPED = "echo newtabkeys\n";
// The keys that the surface keeps and gives to its region, and where the keyboard went, so that a failure names where the keys
// stopped.
const READS = ["native.surface.key_kept", "native.surface.keys_delivered", "native.surface.keys_dropped",
  "native.window.first_responder", "native.input.key_down"];

for (const app of Object.values(APPS)) {
  test(`${app.name}: keys typed as a new tab opens reach its image region whole`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s, { log: { input: "debug" }, reads: READS });
    // A pointer move that presses nothing makes the window the virtual key window.
    const adding = await s.request("element.rect", { name: "core.space-tab.add" });
    await s.pointer(adding.x + adding.width / 2, adding.y + adding.height / 2, "move");
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    const card = focusedCard(await s.get("core.grid")).id;
    const { tab } = await s.run("core.card.add-tab", { card, plugin: RASTER_PROBE });
    // No wait for the view: the reply of the call is the first moment a person could know that the tab opened.
    for (const key of TYPED) {
      const [name, options] = key === "\n" ? ["Enter", {}] : [key === " " ? "Space" : key, { text: key }];
      await s.key(name, "down", options);
      await s.key(name, "up", options);
    }
    await readyRasterProbe(s, tab);
    await s.until("rasterprobe.input", (input) => typedText(input.log) === TYPED,
      `the keys of ${JSON.stringify(TYPED)} did not reach the image region whole and in order`, { surface: tab });
    const log = await receivedAfter(s, tab, 0, "the sidecar did not echo the input transactions");
    assertReceivedUnchanged(log, `${app.name} new tab keys`);
    assert.equal(typedText(log), TYPED);
  });
}
