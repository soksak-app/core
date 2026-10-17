// Reports a registration loss during a document reload together with the performance record.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: fixture reload retains core registrations and records their lifecycle`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    const rowsSince = async (offsets) => {
      await s.flushLog();
      return traceRows(readEvents(app.configDir, offsets).events);
    };
    for (let run = 1; run <= 3; run++) {
      const before = currentEventOffsets(app.configDir);
      const started = performance.now();
      t.diagnostic(`registration lifecycle run ${run} started`);
      try {
        const shell = await fresh(s, { performanceTrace: true });
        const document = await s.get("core.surface.document", shell.surface);
        assert.equal(document.readyState, "complete");
        const rows = await rowsSince(before);
        assert.ok(rows.some((row) => row.event === "surface.registration" && row.phase === "registered" &&
          row.name === "core.surface.document"), "the trace omitted core document registration");
        t.diagnostic(`registration lifecycle run ${run} passed in ${Math.round(performance.now() - started)} ms`);
      } catch (error) {
        const rows = (await rowsSince(before)).filter((row) => row.event === "surface.registration");
        t.diagnostic(`registration lifecycle run ${run} failed in ${Math.round(performance.now() - started)} ms`);
        throw new Error(`${error.message}; registration timeline: ${JSON.stringify(rows)}`, { cause: error });
      }
    }
  });
}
