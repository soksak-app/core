// The benchmark of the browser view. B3 output (SOKSAK_B3_OUT, cases/b3-run.mjs): the keys of
// browser-view in B3_MEASUREMENTS of measurements.mjs.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { runViewMeasurements } from "@soksak/window-check/view-metrics.mjs";
import { fresh } from "../fixture.mjs";
import { b3Conditions, b3Target, fixtureSettings, withB3Out } from "./cases/b3-run.mjs";
import { B3_MEASUREMENTS, B3_SETTINGS } from "./measurements.mjs";
import { collectBrowserViewMeasurements } from "./cases/browser.mjs";
import { browserViewDescriptor } from "./cases/browser.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: browser view process and frame measurements meet the declared contract`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await withB3Out(b3Target(process.env, B3_MEASUREMENTS["browser-view"]), async (run) => {
      await fresh(s, { ...fixtureSettings(B3_SETTINGS["browser-view"]), reads: [
        "host.trace.view.process-request",
        "host.trace.view.process-ready",
        "plugin.browser.view.content_frame",
      ] });
      run.conditions = await b3Conditions(s, B3_SETTINGS["browser-view"]);
      const result = await runViewMeasurements(t, s, {
        plugin: browserViewDescriptor.plugin,
        baselinesMs: { wailsv3: 13, tauriv2: 22 },
        collect: () => collectBrowserViewMeasurements(t, s, browserViewDescriptor),
      });
      const directory = join(app.configDir, "logs", "browser-view-metrics");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${process.pid}.json`);
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
      t.diagnostic(`browser view measurement evidence ${path}`);
      assert.equal(result.evaluation.plugin, "browser");
      assert.equal(result.evaluation.host, app.name);
    });
  });
}
