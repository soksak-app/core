// Measures by recording whether the window shows an incompletely drawn screen while the page changes (docs/spec/surface-composition.md). The places it
// looks at in each frame are those of screen-drawn.mjs, and the reference of each recording is its first frame.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { cardPoint, LOGO, undrawn } from "./screen-drawn.mjs";

async function record(s, action) {
  const { displayed } = await s.presented();
  const recording = await s.record();
  try {
    await action();
    const shown = await s.presented();
    const stop = await recording.stop({ after: Math.max(displayed, shown.displayed) + 100 });
    assert.equal(stop.limited, false, "the recording reached its frame cap");
    return frames(recording.frames).map(readFrame);
  } finally {
    // If the recording cannot be stopped, the session cleanup stops it (Session.record).
    rmSync(recording.frames, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: page changes keep the window drawn`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const card = cardPoint(await s.get("core.grid"));
    const reloaded = await record(s, async () => {
      const before = (await s.get("core.window.workbench")).start;
      await s.run("host.window.reload");
      await s.until("core.window.workbench", (workbench) => workbench.start !== before && workbench.readyState === "complete",
        "the workbench did not start again");
    });
    const reload = undrawn(reloaded, { logo: LOGO, card, reference: reloaded[0] });
    const browsed = await record(s, async () => {
      await s.run("core.projects.browse");
      await s.until("core.screen", (value) => value.screen === "library", "the library did not open");
      await s.run("core.library.return");
      await s.until("core.screen", (value) => value.screen === "workspace", "the library did not return to the workspace");
    });
    const library = undrawn(browsed, { logo: LOGO, card: null, reference: browsed[0] });
    t.diagnostic(`reload: ${reload.length} undrawn frames ${JSON.stringify(reload.slice(0, 6))}; library: ${library.length}`);
    assert.deepEqual(reload, [], "a reload showed frames without the logo at its place or without the card");
    assert.deepEqual(library, [], "opening and leaving the library showed frames without the logo at its place");
  });
}
