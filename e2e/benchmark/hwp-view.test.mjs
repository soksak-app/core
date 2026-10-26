import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { runViewMeasurements } from "@soksak/window-check/view-metrics.mjs";
import { fresh } from "../fixture.mjs";
import { collectHwpViewMeasurements } from "./cases/hwp.mjs";

const BASELINES_MS = Object.freeze({ wailsv3: 701, tauriv2: 813 });

for (const app of Object.values(APPS)) {
  test(`${app.name}: HWP process, history, layout, and drag measurements meet the declared contract`,
    { timeout: 240000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, {
        performanceTrace: true,
        log: { frame: "trace" },
        reads: [
          "host.trace.view.process-request",
          "host.trace.view.process-ready",
          "plugin.hwp.view.content_frame",
        ],
      });
      const result = await runViewMeasurements(t, s, {
        plugin: "hwp",
        baselinesMs: BASELINES_MS,
        collect: async () => collectHwpViewMeasurements(t, s, { baselineMs: BASELINES_MS[app.name] }),
      });
      const directory = join(app.configDir, "logs", "hwp-view-metrics");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${process.pid}.json`);
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
      t.diagnostic(`HWP view measurement evidence ${path}`);
      assert.equal(result.evaluation.plugin, "hwp");
      assert.equal(result.evaluation.host, app.name);
    });
}
