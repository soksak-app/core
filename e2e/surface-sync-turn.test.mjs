// Checks that a surface layout runs in one turn of the main thread, so other main-thread work does not run inside its transaction.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a surface layout enters the main thread once and its ready callback once`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { performanceTrace: false, log: { frame: "trace" }, reads: ["host.frame.surface.dispatch"] });
      const grid = await s.get("core.grid");
      const card = grid.cards.find((c) => c.tabs.some((tab) => tab.plugin === "terminal"));
      assert.ok(card, "no terminal card");
      await s.presented();
      const offsets = currentEventOffsets(app.configDir);
      await s.run("core.card.fullscreen", { card: card.id });
      await s.presented();
      await s.run("core.card.fullscreen", { card: card.id });
      await s.presented();
      await s.flushLog();
      const stages = readEvents(app.configDir, offsets).events
        .filter((event) => event.event === "host.frame.surface.dispatch" && event.fields.operation === "sync")
        .map((event) => event.fields.stage);
      assert.ok(stages.length > 0, "no surface dispatch record");
      const layouts = stages.filter((stage) => stage === "sync-layout-ui").length;
      const count = {};
      for (const stage of stages) count[stage] = (count[stage] ?? 0) + 1;
      assert.deepEqual(count, { "sync-layout-ui": layouts, "sync-layout-ready-callback": layouts },
        `main-thread entries of ${layouts} layouts: ${JSON.stringify(count)}`);
    });
}
