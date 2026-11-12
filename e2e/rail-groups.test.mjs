// Checks that the rail of the fixed sidebar and the rail of an override card are drawn as one loop when adjacent and as two loops when apart, and that the card full screen and the restoration keep
// the same rule (docs/spec/external-sidebars.md). The full screen hides the fixed sidebars, so there is no rail.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, keepCommonSettings, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

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

  // Records while the state changes, as the evidence of the change, and checks the rail that the application reports.
  const record = async (label, change, loops) => {
    const recording = await s.record();
    await change();
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed });
    const rail = await s.get("core.rail");
    // The full screen hides the fixed sidebars together with the other cards, so there is no rail (loops 0).
    assert.equal(rail.groups.length, loops === 0 ? 0 : 1, `${label}: ${rail.groups.length} rail groups`);
    if (loops > 0) assert.equal(rail.groups[0].loops.length, loops, `${label}: ${rail.groups[0].loops.length} rail loops, expected ${loops}`);
    const verify = (await s.get("core.verify")).rows.filter((row) => !row.ok);
    assert.deepEqual(verify, [], `${label}: layout verification failed`);
    t.diagnostic(`${label}: ${recordingSummary(stopped)}, ${loops} loop(s)`);
  };

  // In the default layout, the card of the start tab adjoins the right fixed sidebar.
  await record("adjacent", () => s.run("core.card.focus", { card: own }), 1);
  const { tab } = await s.run("core.card.split", { card: own, side: "right", plugin });
  const split = (await s.get("core.grid")).cards.find((card) => card.tabs.some((item) => item.id === tab));
  assert.ok(split, "the split card is missing");
  s.cleanupSteps(
    async () => {
      if ((await s.get("core.grid")).fullscreen !== null) await s.run("core.card.fullscreen", { card: own });
    },
    async () => {
      await s.run("core.tab.close", { tab });
      await s.presented();
    },
  );
  // The split right card stands between them, so the left card of the start tab is apart from the sidebar.
  await record("detached", () => s.run("core.card.focus", { card: own }), 2);
  await record("adjacent split", () => s.run("core.card.focus", { card: split.id }), 1);
  await record("fullscreen", async () => {
    await s.run("core.card.focus", { card: own });
    await s.run("core.card.fullscreen", { card: own });
  }, 0);
  await record("restored", () => s.run("core.card.fullscreen", { card: own }), 2);
});
