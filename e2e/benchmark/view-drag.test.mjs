import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { collectTerminalDrag } from "./cases/terminal.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: terminal view drag meets performance targets with performance and renderer traces disabled`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      const terminal = await fresh(s, { performanceTrace: false });
      const result = await collectTerminalDrag(t, s, terminal, app.configDir);
      const report = { ...result.report, layouts: result.drag.layouts };
      const path = join(result.directory, "result.json");
      writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
      t.diagnostic(`benchmark report ${path}: ${JSON.stringify(report.performance)}`);
      t.diagnostic(`transaction cadence (ms): ${JSON.stringify(report.transactionCadence)}`);
      assert.ok(report.frameCount > 30, "the benchmark has too few captured frames");
      result.assertPerformance();
    });
}
