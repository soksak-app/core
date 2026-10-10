// Checks by recording that the rail of the fixed sidebar and the rail of an override card are drawn as one loop when adjacent and as two loops when apart, and that the card full screen and the restoration keep
// the same rule (docs/spec/external-sidebars.md). The full screen hides the fixed sidebars, so there is no rail.
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { railPixels } from "./rail.mjs";

for (const app of Object.values(APPS)) test(`${app.name}: rail groups follow adjacent, detached, fullscreen and restored cards`, { timeout: 90000 }, async (t) => {
  const s = await open(t, app);
  assert.ok(s, "required host is not built");
  await fresh(s);
  await keepCommonSettings(s);
  await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
  // The right override of the terminal plugin ties the right fixed sidebar to the terminal card.
  await s.run("core.settings.link", { place: "window-right", plugin: "terminal", set: "set-install", scope: "common" });

  // Records while the state changes, and measures whether the recording is complete and the rail color of the last frame.
  const record = async (label, change, loops) => {
    const recording = await s.record();
    const directory = recording.frames;
    await change();
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed });
    try {
      assert.equal(stopped.limited, false, `${label}: the recording reached its frame limit`);
      assert.ok(stopped.count > 0, `${label}: the recording has no frames`);
      assert.ok(stopped.longestGap <= 100, `${label}: the recording has a ${stopped.longestGap}ms gap`);
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

  // In the default layout, the terminal card adjoins the right fixed sidebar.
  await record("adjacent", () => s.run("core.card.focus", { card: "terminal" }), 1);
  const { tab } = await s.run("core.card.split", { card: "terminal", side: "right", plugin: "terminal" });
  const split = (await s.get("core.grid")).cards.find((card) => card.tabs.some((item) => item.id === tab));
  assert.ok(split, "the split card is missing");
  s.cleanup(async () => {
    if ((await s.get("core.grid")).fullscreen !== null) await s.run("core.card.fullscreen", { card: "terminal" });
    await s.run("core.tab.close", { tab });
    await s.presented();
  });
  // The split right card stands between them, so the left terminal card is apart from the sidebar.
  await record("detached", () => s.run("core.card.focus", { card: "terminal" }), 2);
  await record("adjacent split", () => s.run("core.card.focus", { card: split.id }), 1);
  await record("fullscreen", async () => {
    await s.run("core.card.focus", { card: "terminal" });
    await s.run("core.card.fullscreen", { card: "terminal" });
  }, 0);
  await record("restored", () => s.run("core.card.fullscreen", { card: "terminal" }), 2);
});
