// Observes the saved card-right setting of the plugin of an active tab and the return from the full screen while it preserves the user
// tabs and settings of the current window. The observed card is the first card whose active tab has a saved card-right link of its plugin.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, judgeShownChanges, open, owe } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";

for (const app of Object.values(APPS))
  test(`${app.name}: current card right sidebar follows saved plugin settings`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    const settings = (await s.get("core.settings")).values;
    const initial = await s.get("core.grid");
    assert.equal(initial.fullscreen, null, "start observation from normal card presentation");
    const linkOf = (card) => {
      const plugin = card.tabs?.find((tab) => tab.id === card.active)?.plugin;
      return settings.links.find((link) => link.place === "card-right" && link.plugin === plugin && plugin !== undefined);
    };
    const target = initial.cards.find(linkOf);
    assert.ok(target, "a card whose active tab has a saved card-right assignment of its plugin is required");
    const link = linkOf(target);
    assert.equal(target.sidebars.right?.set, link.set, `saved ${link.plugin} setting is suppressed by the card selection`);
    const original = (await s.get("core.layout")).state;
    const recording = await s.request("diagnostics.capture.start", {});
    let stop,
      displayed = 0;
    // The times of the changes of the screen during the recording (judgeShownChanges).
    const owed = [];
    async function measure(mode) {
      const bars = await s.until(
        "core.sidebars",
        (bars) =>
          bars.some(
            (bar) =>
              bar.sidebar === `${target.id}:right` &&
              bar.set === link.set &&
              bar.sections.some((section) => section.mounted && section.phase === "ready") &&
              bar.sections.every((section) => section.error === null),
          ),
        `${mode}: right section view not ready`,
      );
      const grid = await s.get("core.grid"),
        card = grid.cards.find((card) => card.id === target.id);
      assert.equal(card.sidebars.right.set, link.set);
      const bar = bars.find((bar) => bar.sidebar === `${target.id}:right`);
      assert.equal(bar.orientation, "vertical");
      assert.ok(bar.rect.w > 0 && bar.rect.h > 0);
      const native = (await s.get("core.surfaces")).find((surface) => surface.surface === target.active);
      assert.ok(native?.applied, "the native rectangle of the active tab is absent");
      assert.ok(native.applied.w <= card.w - bar.rect.w, "the active tab covers its right sidebar");
      assert.deepEqual(
        (await s.get("core.verify")).rows.filter((row) => !row.ok),
        [],
      );
      ({ displayed } = await s.presented());
      t.diagnostic(
        `${mode}: card=${JSON.stringify({ x: card.x, y: card.y, w: card.w, h: card.h })}; right=${JSON.stringify(bar.rect)}; native=${JSON.stringify(native.applied)}; sections=${bar.sections.map((section) => section.id)}; endpoint=${s.client.endpoint.pid}`,
      );
    }
    try {
      await measure("normal");
      // Each full screen toggle changes the screen, so the recording owes it a frame (judgeShownChanges).
      owed.push(await owe(s));
      await s.run("core.card.fullscreen", { card: target.id });
      try {
        await measure("fullscreen");
      } finally {
        owed.push(await owe(s));
        await s.run("core.card.fullscreen", { card: target.id });
      }
      await measure("restored");
      assert.deepEqual((await s.get("core.settings")).values, settings);
      assert.deepEqual((await s.get("core.layout")).state, original, "observation changed saved cards or tabs");
    } finally {
      try {
        stop = await s.request("diagnostics.capture.stop", { after: displayed ? displayed + 100 : 0 });
        const captured = frames(recording.frames).map(readFrame);
        assert.equal(captured.length, stop.count);
        assert.ok(captured.length > 2);
        assert.equal(stop.limited, false);
        judgeShownChanges(stop, owed, { what: "full screen toggle" });
        t.diagnostic(`frames=${stop.count}; gap=${stop.longestGap}ms`);
      } finally {
        rmSync(recording.frames, { recursive: true, force: true });
      }
    }
  });
