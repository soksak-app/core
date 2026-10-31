import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { runViewMeasurements } from "@soksak/window-check/view-metrics.mjs";
import { fresh } from "../fixture.mjs";
import { collectEditorMotionMeasurements, finishEditorMeasurements, prepareEditorMeasurements }
  from "./cases/editor.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: editor process, footprint, layout, and drag measurements meet the declared contract`,
    { timeout: 240000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { performanceTrace: true, log: { frame: "trace" }, reads: [
        "host.trace.view.process-request",
        "host.trace.view.process-ready",
        "plugin.editor.view.content_frame",
      ] });
      const result = await runViewMeasurements(t, s, {
        plugin: "editor",
        baselinesMs: { wailsv3: 13, tauriv2: 35 },
        measureEditorFootprint: true,
        collect: async () => {
          const prepared = await prepareEditorMeasurements(t, s);
          const motion = await collectEditorMotionMeasurements(t, s, prepared);
          return finishEditorMeasurements(t, s, prepared, motion);
        },
      });
      const directory = join(app.configDir, "logs", "editor-view-metrics");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${process.pid}.json`);
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
      t.diagnostic(`editor view measurement evidence ${path}`);
      assert.equal(result.evaluation.plugin, "editor");
      assert.equal(result.evaluation.host, app.name);
    });
}
