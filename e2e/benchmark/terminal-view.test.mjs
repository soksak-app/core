import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { runViewMeasurements } from "@soksak/window-check/view-metrics.mjs";
import { fresh } from "../fixture.mjs";
import { collectTerminalViewMeasurements, terminalViewDescriptor } from "./cases/terminal.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: terminal view process and frame measurements meet the declared contract`,
    { timeout: 180000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { performanceTrace: true, log: { frame: "trace" }, reads: [
        "host.trace.view.process-request",
        "host.trace.view.process-ready",
        "plugin.terminal.view.content_frame",
      ] });
      const result = await runViewMeasurements(t, s, {
        plugin: terminalViewDescriptor.plugin,
        baselinesMs: { wailsv3: 17, tauriv2: 23 },
        collect: () => collectTerminalViewMeasurements(t, s, terminalViewDescriptor, app.configDir),
      });
      const directory = join(app.configDir, "logs", "terminal-view-metrics");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${process.pid}.json`);
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
      t.diagnostic(`terminal view measurement evidence ${path}`);
      assert.equal(result.evaluation.plugin, "terminal");
      assert.equal(result.evaluation.host, app.name);
    });
}
