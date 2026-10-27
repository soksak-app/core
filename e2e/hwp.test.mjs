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
import { monotonicTimeMs, openRecordedView, viewCardWithDifferentPluginTab } from "./view-metrics-collection.mjs";
import { openHwp, studio } from "./hwp-support.mjs";
import { hwpViewDescriptor, HWP_VIEW_BASELINES_MS } from "./benchmark/cases/hwp.mjs";

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
    const failures = [];
    let startAttempted = false;
    let opened;
    const recordFailure = (step, error) => {
      failures.push({ step, error });
      evidence.errors.push({ step, message: String(error?.message ?? error) });
      persist();
    };
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
      const descriptor = await hwpViewDescriptor(s, (message) => t.diagnostic(message),
        HWP_VIEW_BASELINES_MS[app.name] + 300);
      assert.ok(descriptor.params?.path, "HWP resource timing fixture has no document path");
      const grid = await s.get("core.grid");
      const card = viewCardWithDifferentPluginTab(grid, "hwp", grid.cards.find((item) => item.active)?.id);
      opened = await openRecordedView(t, s, { card, ...descriptor, deferContentVerification: true });
      evidence.surface = opened.surface;
      evidence.path = descriptor.params.path;
      evidence.requestAtMs = opened.requestAtMs;
      evidence.processStart = opened.processStart;
      evidence.recording = { directory: opened.recording.directory, frameCount: opened.recording.frameCount };
      persist();

      startAttempted = true;
      evidence.start = await s.run("hwp.diagnostics.frames.start", {}, opened.surface);
      persist();

      try {
        evidence.readClockBefore = await monotonicTimeMs(s);
        persist();
      } catch (error) {
        recordFailure("read clock before", error);
      }
      try {
        evidence.read = await s.run("hwp.diagnostics.frames.read", {}, opened.surface);
        persist();
      } catch (error) {
        recordFailure("read", error);
      }
      try {
        evidence.readClockAfter = await monotonicTimeMs(s);
        persist();
      } catch (error) {
        recordFailure("read clock after", error);
      }
    } catch (error) {
      recordFailure("open or start", error);
    } finally {
      if (startAttempted) {
        try {
          evidence.stop = await s.run("hwp.diagnostics.frames.stop", {}, evidence.surface);
          persist();
        } catch (error) {
          recordFailure("stop", error);
        }
      }
    }

    if (opened) {
      try {
        const content = await opened.verifyContent();
        const elapsedMs = content.contentFrame.timeMs - opened.requestAtMs;
        assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0,
          `HWP first-content elapsed time is invalid: ${JSON.stringify(elapsedMs)}`);
        evidence.firstContent = { ...content.contentFrame, elapsedMs };
        persist();
      } catch (error) {
        recordFailure("offline first-content verification", error);
      }
    }

    if (failures.length === 1) throw failures[0].error;
    if (failures.length > 1) {
      throw new AggregateError(failures.map(({ error }) => error),
        `HWP resource timing evidence failed at ${failures.map(({ step }) => step).join(", ")}`);
    }
    assert.equal(evidence.start?.enabled, true, "HWP resource timing start did not enable diagnostics");
    assert.ok(Number.isFinite(evidence.readClockBefore?.timeMs) && Number.isFinite(evidence.readClockAfter?.timeMs)
      && evidence.readClockAfter.timeMs >= evidence.readClockBefore.timeMs,
    "HWP resource timing read has no valid host monotonic bracket");
    assert.ok(Number.isFinite(evidence.read?.studioClock?.documentTimeOriginMs)
      && Number.isFinite(evidence.read?.studioClock?.snapshotAtMs),
    "HWP resource timing read has no studio document clock");
    assert.ok(Array.isArray(evidence.read?.resourceTimings),
      "HWP resource timing read did not return the available Resource Timing entries");
    assert.equal(evidence.stop?.enabled, false, "HWP resource timing stop left diagnostics active");
    assert.equal(evidence.stop?.studioViewport, null, "HWP resource timing stop left the viewport marker active");
  });
}
