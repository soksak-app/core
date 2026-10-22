// Checks that each installed plugin whose surface composition is a view shows its page in a card: core.surfaces reports the
// composition, a recording of the card reaches a first content frame, and the audit of the view document has no unbound element
// (docs/spec/native-surfaces.md, docs/spec/exposure.md). The plugins are read from core.surfaces, so this module names no plugin
// except the terminal card that fresh prepares.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { unansweredViewCalls } from "@soksak/window-check/view-calls.mjs";
import { fresh } from "./fixture.mjs";

/** Samples per axis of the card area; a frame whose sampled points show one colour is blank. */
const SAMPLES = 16;

/** The number of distinct colours at the sampled points of the card area of the frame. */
function colours(frame, grid, card) {
  const ratio = frame.scale * frame.contentScale;
  const seen = new Set();
  for (let i = 1; i < SAMPLES; i++) {
    for (let j = 1; j < SAMPLES; j++) {
      const x = Math.floor((grid.plane.x + card.x + (card.w * i) / SAMPLES) * ratio);
      const y = Math.floor((grid.plane.y + card.y + (card.h * j) / SAMPLES) * ratio);
      seen.add(pixel(frame, x, y).join(","));
    }
  }
  return seen.size;
}

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
  test(`${app.name}: each installed view plugin shows its first content in a card`, { timeout: 240000 }, async (t) => {
    const s = await open(t, app);
    // The view calls of the page are records at the debug level of the class call; the check declares that policy, and the
    // preparation restores the setting when the check ends (keepCommonSettings).
    const offsets = currentEventOffsets(s.app.configDir);
    await untilViewReady(s, offsets, () => fresh(s, { log: { call: "debug" }, reads: ["page.view.call", "page.view.reply"] }));
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(card, "no card holds the fixture terminal");
    const views = [...new Map((await s.get("core.surfaces"))
      .filter((surface) => surface.composition === "view").map((surface) => [surface.plugin, surface])).values()];
    t.diagnostic(`view plugins listed by core.surfaces: ${views.map((surface) => surface.plugin).join(", ") || "none"}`);
    assert.ok(views.length > 0, "core.surfaces lists no surface with composition view");
    for (const view of views) {
      const recording = await s.record({});
      let displayed = 0;
      let stopped;
      let tab;
      try {
        ({ tab } = await s.run("core.card.add-tab", { card: card.id, plugin: view.plugin }));
        await s.until("core.surfaces", (all) => all.some((item) => item.plugin === view.plugin && item.visible
          && item.exposes.includes("status core.surface.document")), `view ${view.plugin} did not show its document`);
        ({ displayed } = await s.presented());
      } finally {
        stopped = await recording.stop({ after: displayed ? displayed + 100 : 0 });
      }
      const captured = frames(recording.frames).map(readFrame);
      assert.equal(stopped.limited, false, `${view.plugin}: recording reached its bounded buffer`);
      assert.ok(captured.length > 1, `${view.plugin}: recording has ${captured.length} frames`);
      const grid = await s.get("core.grid");
      const shown = grid.cards.find((item) => item.id === card.id);
      const counts = captured.map((frame) => colours(frame, grid, shown));
      const first = counts.findIndex((count) => count > 1);
      assert.ok(first >= 0, `${view.plugin}: no recorded frame of the card has content (${counts.length} frames)`);
      assert.ok(counts.at(-1) > 1, `${view.plugin}: the last recorded frame of the card is blank`);
      t.diagnostic(`${view.plugin}: first content frame ${first + 1} of ${captured.length}, gap=${stopped.longestGap}ms`);

      const now = (await s.get("core.surfaces")).find((item) => item.plugin === view.plugin && item.visible);
      assert.equal(now.composition, "view", `${view.plugin} reports composition ${now.composition}`);
      const doc = await s.get("core.surface.document", now.surface);
      assert.deepEqual(doc.unbound, [], `${view.plugin}: view document controls without a command or dom name`);
      await s.run("core.tab.close", { tab });
      await s.until("core.surfaces", (all) => !all.some((item) => item.plugin === view.plugin && item.visible),
        `view ${view.plugin} did not close`);
    }
    assert.deepEqual((await s.get("core.page.audit")).unbound, [], "main document controls without a command or dom name");
  });
}
