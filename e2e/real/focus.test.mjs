// Checks that the address bar of a browser card does not receive the focus for a moment when the terminal card is really pressed (V5-114, V5-114-1).
// The terminal area is click-transparent, so a press lets the main document take the focus back, and the address bar that stayed as activeElement
// received the focus at that moment and was shown. The check records the whole process of a real HID click, collects every core.focus change in that time, and confirms that there is no
// focus transition into the address bar and that the native first responder goes to the pressed terminal.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
import { ensureTerminals } from "../terminal-screen.mjs";
import { bringFront, click, requireTrusted, screenCenter } from "./hid.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real terminal press never moves focus to the browser address field`, { timeout: 120000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const terminals = await ensureTerminals(s, 2);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === terminals[1].surface));
    const { tab: browser } = await s.run("core.card.split", { card: card.id, side: "bottom", plugin: "browser" });
    s.cleanup(() => s.run("core.tab.close", { tab: browser }));
    await s.until("core.surfaces", (list) => list.some((item) => item.surface === browser && item.exposes.includes("dom browser.address")),
      "the browser surface did not register its address field");
    await s.presented();

    // Really presses the address bar to give it the focus. The activeElement of the document stays on the address bar after that.
    const field = await s.rect("browser.address", undefined, browser);
    const point = await bringFront(s, app, field);
    click(point.x, point.y);
    await s.until("core.focus", (focus) => focus?.name === "browser.address" && focus.surface === browser,
      "a real click on the address field did not give it focus in core.focus");

    // The recording sends stop once, and the session cleanup stops a recording that was not stopped and deletes the folder (Session.record).
    const recording = await s.record();
    const directory = recording.frames;
    const focus = await s.collect("core.focus");
    for (const terminal of terminals) {
      const target = await screenCenter(s, await s.rect("terminal.view", undefined, terminal.surface));
      click(target.x, target.y);
      await s.until("host.window", (window) => window.responder?.surface === terminal.surface,
        `${terminal.surface} did not become the native first responder after a real click`);
    }
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed });
    const values = await focus.stop();

    assert.equal(stopped.limited, false, "the recording reached its frame limit");
    assert.ok(frames(directory).length > 0, "the recording has no frames");
    assert.ok(stopped.longestGap <= 100, `the recording has a ${stopped.longestGap}ms gap`);
    // The first value is the state (address bar) when the watch starts. Every focus that enters the address bar again after that is a transition.
    const transitions = values.slice(1).filter((value, index) => value?.name === "browser.address" &&
      values[index]?.name !== "browser.address");
    assert.deepEqual(transitions, [], `focus moved to the address field during the terminal presses: ${JSON.stringify(values)}`);
    const host = await s.get("host.window");
    assert.equal(host.responder?.surface, terminals[1].surface, "the last pressed terminal is not the native first responder");
    assert.deepEqual(host.regions.filter((region) => region.focused).map((region) => region.surface), [terminals[1].surface]);
    t.diagnostic(`core.focus values ${JSON.stringify(values)}; ${stopped.count} frames, maximum gap ${stopped.longestGap}ms`);
  });
}
