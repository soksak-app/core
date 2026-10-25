// Checks installed view display using explicit per-plugin content cases and declared surface/document statuses.
// Missing content cases fail explicitly; sampled colour variation alone does not establish plugin content.
import test from "node:test";
import assert from "node:assert/strict";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { unansweredViewCalls } from "@soksak/window-check/view-calls.mjs";
import { fresh } from "./fixture.mjs";
import { viewContentCases } from "./view-content.mjs";
import { checkViewDisplay } from "./view-display.mjs";

/**
 * Runs the wait of a view check. When the wait fails, the failure names each view call that the page received after offsets and
 * never answered, with its plugin, surface, id, command and the time it waited (docs/spec/native-surfaces.md#view-surfaces).
 */
async function untilViewReady(s, offsets, wait) {
  try {
    return await wait();
  } catch (error) {
    await s.flushLog();
    const { events } = readEvents(s.app.configDir, offsets);
    const calls = unansweredViewCalls(events.filter((event) => event.event.startsWith("page.view.")));
    const detail = calls.length === 0 ? "none" : calls.map((call) => `${call.plugin} ${call.surface} call ${call.id} ${call.command} ` +
      `waited ${(call.waitingUs / 1000).toFixed(0)} ms`).join("; ");
    throw new Error(`${error.message}; view calls without a reply: ${detail}`, { cause: error });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: each installed view plugin requires an explicit content case in a card`, { timeout: 240000 }, async (t) => {
    const s = await open(t, app);
    // The view calls of the page are records at the debug level of the class call; the check declares that policy, and the
    // preparation restores the setting when the check ends (keepCommonSettings).
    const offsets = currentEventOffsets(s.app.configDir);
    await untilViewReady(s, offsets, () => fresh(s, { log: { call: "debug" }, reads: ["page.view.call", "page.view.reply"] }));
    await checkViewDisplay(s, t, undefined, await viewContentCases(s, message => t.diagnostic(message)));
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: installed plugin metadata matches the opened view composition`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const opened = await fresh(s);
    const surface = (await s.get("core.surfaces")).find(item => item.surface === opened.surface);
    assert.ok(surface, "the fixture surface is absent");
    assert.equal(surface.composition, "view");
    const installed = await s.get("core.plugins");
    assert.equal(installed.error, null);
    const metadata = installed.plugins.find(item => item.id === surface.plugin);
    assert.ok(metadata?.installed?.enabled, "the opened view plugin is not installed and enabled");
    assert.equal(metadata.composition, surface.composition,
      `${surface.plugin}: installed metadata differs from the opened surface composition`);
  });
}
