// Checks by recording that the rail of the fixed sidebar and the rail of an override card are drawn as one loop when adjacent and as two loops when apart, and that the card full screen and the restoration keep
// the same rule (docs/spec/external-sidebars.md). The full screen hides the fixed sidebars, so there is no rail.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, judgeShownChanges, keepCommonSettings, open, owe } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { railPixels } from "./rail.mjs";

for (const app of Object.values(APPS)) test(`${app.name}: rail groups follow adjacent, detached, fullscreen and restored cards`, { timeout: 90000 }, async (t) => {
  const s = await open(t, app);
  const { surface, plugin } = await fresh(s);
  const own = (await s.get("core.grid")).cards.find((card) => card.tabs?.some((item) => item.id === surface)).id;
  await keepCommonSettings(s);
  await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
  // The right override of the layout probe, a stored set of its sections, ties the right fixed sidebar to the card of the start tab.
  const sets = (await s.get("core.settings")).values.sets;
  const set = { id: "check-rail", title: "Rail", sections: ["layoutprobe.alpha", "layoutprobe.fill"], layout: "list" };
  await s.run("core.settings.set", { patch: { sets: [...sets, set] }, scope: "common" });
  await s.run("core.settings.link", { place: "window-right", plugin, set: set.id, scope: "common" });

  // Records while the state changes, and measures whether the recording is complete and the rail color of the last frame.
  // Whether focusing card `id` changes the screen: it does unless the card has the focus already.
  const focusChanges = async (id) => (await s.get("core.grid")).cards.find((card) => card.id === id)?.focused !== true;
  // `changes` is whether the change changes the screen, which owes a frame to the recording.
  const record = async (label, change, loops, changes) => {
    const recording = await s.record();
    const directory = recording.frames;
    // A change of the screen owes the recording frames from its request to its display (judgeShownChanges).
    const from = changes ? await owe(s) : null;
    await change();
    const { displayed } = await s.presented();
    const owed = from === null ? [] : [{ from, to: displayed }];
    const stopped = await recording.stop({ after: displayed });
    try {
      assert.equal(stopped.limited, false, `${label}: the recording reached its frame limit`);
      assert.ok(stopped.count > 0, `${label}: the recording has no frames`);
      judgeShownChanges(stopped, owed, { what: `${label} change` });
      const rail = await s.get("core.rail");
      // The full screen hides the fixed sidebars together with the other cards, so there is no rail (loops 0).
      assert.equal(rail.groups.length, loops === 0 ? 0 : 1, `${label}: ${rail.groups.length} rail groups`);
      if (loops > 0) assert.equal(rail.groups[0].loops.length, loops, `${label}: ${rail.groups[0].loops.length} rail loops, expected ${loops}`);
      const verify = (await s.get("core.verify")).rows.filter((row) => !row.ok);
      assert.deepEqual(verify, [], `${label}: layout verification failed`);
      try {
        railPixels(readFrame(frames(directory).at(-1)), await s.get("core.grid"), rail);
      } catch (error) {
        throw new Error(`${label}: ${error.message}; loops ${JSON.stringify(rail.groups.map((group) => group.loops))}`, { cause: error });
      }
      t.diagnostic(`${label}: ${stopped.count} frames, maximum gap ${stopped.longestGap}ms, ${loops} loop(s)`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  // In the default layout, the card of the start tab adjoins the right fixed sidebar.
  await record("adjacent", () => s.run("core.card.focus", { card: own }), 1, await focusChanges(own));
  const { tab } = await s.run("core.card.split", { card: own, side: "right", plugin });
  const split = (await s.get("core.grid")).cards.find((card) => card.tabs.some((item) => item.id === tab));
  assert.ok(split, "the split card is missing");
  s.cleanup(async () => {
    if ((await s.get("core.grid")).fullscreen !== null) await s.run("core.card.fullscreen", { card: own });
    await s.run("core.tab.close", { tab });
    await s.presented();
  });
  // The split right card stands between them, so the left card of the start tab is apart from the sidebar.
  await record("detached", () => s.run("core.card.focus", { card: own }), 2, await focusChanges(own));
  await record("adjacent split", () => s.run("core.card.focus", { card: split.id }), 1, await focusChanges(split.id));
  await record("fullscreen", async () => {
    await s.run("core.card.focus", { card: own });
    await s.run("core.card.fullscreen", { card: own });
  }, 0, true);
  await record("restored", () => s.run("core.card.fullscreen", { card: own }), 2, true);
});
