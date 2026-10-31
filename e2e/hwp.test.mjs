// HWP check while the application is inactive: an .hwp file opens from the file tree in the plugin whose surface.opens declares
// hwp, which shows the editor of its package in a document region and exchanges messages with it
// (docs/spec/native-surfaces.md#document-regions). The pages draw their text, and a native press on the page gives the editor
// the keyboard focus. Typing, selecting and saving need the key window of the active application, so
// e2e/activation/hwp.test.mjs covers them (docs/spec/native-surfaces.md, F135).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { openRecordedView, viewCardWithDifferentPluginTab } from "./view-metrics-collection.mjs";
import { openHwp, studio } from "./hwp-support.mjs";
import { hwpViewDescriptor, HWP_VIEW_BASELINES_MS } from "./benchmark/cases/hwp.mjs";
import { collectHwpStartupResourceEvidence } from "./hwp-startup.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an hwp file opens from the tree, draws its pages and takes the keyboard focus on a press`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { performanceTrace: true });
    const { surface } = await openHwp(s);
    // A press on the page in the region gives the editor the keyboard focus and places its caret.
    const region = await studio(s, surface);
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height * 0.8);
    await s.until("host.window", (value) => value.documents.some((item) => item.surface === surface && item.focused),
      "a press in the editor did not give it the keyboard focus");
  });

  test(`${app.name}: HWP startup resource timing snapshot is preserved`, { timeout: 180000 }, async (t) => {
    const runFolder = process.env.SOKSAK_RUN_FOLDER;
    if (typeof runFolder !== "string" || runFolder.length === 0) {
      throw new Error("SOKSAK_RUN_FOLDER is required to preserve HWP resource timing evidence");
    }
    mkdirSync(runFolder, { recursive: true });
    const evidencePath = join(runFolder, `hwp-resource-timing-${app.name}.json`);
    t.diagnostic(`HWP resource timing evidence ${evidencePath}`);
    const evidence = { app: app.name, format: 2, errors: [] };
    const persist = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    let opened;
    let descriptor;
    const s = await open(t, app);
    try {
      await fresh(s, {
        performanceTrace: true,
        log: { lifecycle: "info" },
        reads: [
          "host.trace.view.process-request",
          "host.trace.view.process-ready",
          "plugin.hwp.phase",
          "plugin.hwp.request",
        ],
      });
      descriptor = await hwpViewDescriptor(s, (message) => t.diagnostic(message),
        HWP_VIEW_BASELINES_MS[app.name] + 300);
      assert.ok(descriptor.params?.path, "HWP resource timing fixture has no document path");
      const grid = await s.get("core.grid");
      const card = viewCardWithDifferentPluginTab(grid, "hwp", grid.cards.find((item) => item.active)?.id);
      opened = await openRecordedView(t, s, { card, ...descriptor, deferContentVerification: true });
    } catch (error) {
      evidence.errors.push({ step: "open", message: String(error?.message ?? error) });
      persist();
      throw error;
    }

    await collectHwpStartupResourceEvidence(s, opened, {
      app: app.name,
      path: descriptor.params.path,
      evidence,
      persist,
      recordingCopyDirectory: join(runFolder, `capture-${app.name}`),
    });
  });
}
