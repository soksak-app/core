// The view benchmark of the section views (cases/section-view.mjs): one test for each section view of the enabled installed plugins of
// each application, in the card-left sidebar of terminal cards whose set holds that section alone. No DOM mount was recorded for a
// section view, so (iii) and (iii-b) judge it against the first-display margin alone. A section view whose plugin does not declare the
// section-view contract fails its own test. B3 output (SOKSAK_B3_OUT, cases/b3-run.mjs): the keys of section-view in B3_MEASUREMENTS
// of measurements.mjs.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { runViewMeasurements } from "@soksak/window-check/view-metrics.mjs";
import { fresh, terminalCardSidebar } from "../fixture.mjs";
import { b3Conditions, b3Target, fixtureSettings, withB3Out } from "./cases/b3-run.mjs";
import { collectSectionViewMeasurements, installedSectionViews, sectionViewDescriptor } from "./cases/section-view.mjs";
import { B3_MEASUREMENTS, B3_SETTINGS } from "./measurements.mjs";

for (const app of Object.values(APPS)) {
  for (const view of installedSectionViews(app.configDir)) {
    test(`${app.name}: ${view.plugin} section view ${view.section} process and frame measurements meet the declared contract`,
      { timeout: 300000 }, async (t) => {
        const s = await open(t, app);
        await withB3Out(b3Target(process.env, B3_MEASUREMENTS["section-view"]), async (run) => {
          await fresh(s, { ...fixtureSettings(B3_SETTINGS["section-view"]), reads: [
            "host.trace.view.process-request",
            "host.trace.view.process-ready",
            `plugin.${view.plugin}.view.content_frame`,
          ] });
          run.conditions = await b3Conditions(s, B3_SETTINGS["section-view"]);
          const descriptor = sectionViewDescriptor(view);
          await terminalCardSidebar(s, { sections: [view.section] });
          const result = await runViewMeasurements(t, s, {
            plugin: descriptor.plugin,
            baselinesMs: null,
            collect: () => collectSectionViewMeasurements(t, s, descriptor),
          });
          const directory = join(app.configDir, "logs", "section-view-metrics");
          mkdirSync(directory, { recursive: true });
          const path = join(directory, `${view.section}.${process.pid}.json`);
          writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
          t.diagnostic(`${view.plugin} section view ${view.section} measurement evidence ${path}`);
          assert.equal(result.evaluation.plugin, view.plugin);
          assert.equal(result.evaluation.host, app.name);
        });
      });
  }
}
