import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { viewContentCases } from "../view-content.mjs";
import { monotonicTimeMs, openRecordedView, viewCardWithDifferentPluginTab }
  from "../view-metrics-collection.mjs";
import { collectEditorProcessFootprint, collectHiddenEditorFootprint, editorViewDescriptor }
  from "./cases/editor.mjs";

async function closeEditorSurface(s, surface) {
  if (surface === undefined) return;
  const surfaces = await s.get("core.surfaces");
  if (!surfaces.some((item) => item.surface === surface)) return;
  const result = await s.run("core.tab.close", { tab: surface });
  assert.equal(result?.closed, true, `Editor surface ${surface} did not close`);
  await s.until("core.surfaces", (items) => !items.some((item) => item.surface === surface),
    `Editor surface ${surface} remained registered after close`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: normal and hidden-only Editor process footprints are measured`,
    { timeout: 90000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { performanceTrace: true, log: { frame: "trace" }, reads: [
        "host.trace.view.process-request",
        "host.trace.view.process-ready",
      ] });
      const cases = await viewContentCases(s, (message) => t.diagnostic(message));
      const descriptor = editorViewDescriptor(cases.get("editor"));
      const grid = await s.get("core.grid");
      const activeCard = grid.cards.find((item) => item.active);
      const card = viewCardWithDifferentPluginTab(grid, "editor", activeCard?.id);
      let normalView;
      let normalSurface;
      let normalClosed = false;
      let hiddenView;
      let operationError;
      try {
        const opened = await openRecordedView(t, s, { card, ...descriptor });
        normalSurface = opened.surface;
        assert.equal(opened.contentFrame.proof.expected, descriptor.expectedContent,
          "normal Editor first-content proof has an unexpected document");
        assert.ok(opened.contentFrame.timeMs >= opened.requestAtMs,
          "normal Editor first-content frame predates the view request");
        assert.equal(opened.readinessEvidence.historyEntries, 1, "normal Editor view history is not initial-only");
        assert.equal(opened.readinessEvidence.regionHistoryEntries, 0, "normal Editor view unexpectedly has document regions");
        const sampledAt = { before: await monotonicTimeMs(s) };
        const processGroup = await collectEditorProcessFootprint(s, [normalSurface]);
        sampledAt.after = await monotonicTimeMs(s);
        assert.ok(sampledAt.before.timeMs >= opened.contentFrame.timeMs,
          "normal Editor footprint sampling started before its first OCR-confirmed content frame");
        assert.ok(sampledAt.after.timeMs >= sampledAt.before.timeMs,
          "normal Editor footprint sample clock moved backward");
        assert.deepEqual(processGroup.surfaces, [normalSurface],
          "normal Editor process group is shared with another live surface");
        assert.ok(processGroup.processes.length > 0, "normal Editor footprint group is empty");
        for (const process of processGroup.processes) {
          assert.ok(Number.isSafeInteger(process.pid) && process.pid > 0, "normal Editor process PID is invalid");
          assert.ok(Number.isSafeInteger(process.footprintBytes) && process.footprintBytes > 0,
            `normal Editor process ${process.pid} footprint is invalid`);
        }
        normalView = { surface: normalSurface, requestAtMs: opened.requestAtMs,
          requestEvent: opened.processStart.requestEvent, firstContentFrame: opened.contentFrame,
          recording: { directory: opened.recording.directory, frameCount: opened.recording.frameCount,
            anchorContentFrame: opened.recording.anchorContentFrame },
          readinessEvidence: opened.readinessEvidence, samplingClock: sampledAt,
          processGroupPids: processGroup.pids, processGroupSurfaces: processGroup.surfaces,
          processes: processGroup.processes };
        await closeEditorSurface(s, normalSurface);
        normalClosed = true;
        hiddenView = await collectHiddenEditorFootprint(s, normalView.processes);
        assert.ok(hiddenView.editorFootprint.viewBytes > 0, "normal Editor process-group total is not positive");
        assert.ok(hiddenView.editorFootprint.hiddenDomBytes > 0, "hidden-only Editor process-group total is not positive");
        assert.equal(hiddenView.evidence.fixture.mounted, true);
        assert.equal(hiddenView.evidence.fixture.documentLength, "SOKSAK EDITOR CONTENT\n".length);
        assert.equal(hiddenView.evidence.fixture.lines, 2);
        assert.equal(hiddenView.evidence.fixture.historyEntries, 1);
        assert.equal(hiddenView.evidence.fixture.regionHistoryEntries, 0);
        assert.ok(hiddenView.evidence.hiddenProcesses.length > 0, "hidden-only Editor footprint group is empty");
        for (const process of hiddenView.evidence.hiddenProcesses) {
          assert.ok(Number.isSafeInteger(process.pid) && process.pid > 0, "hidden-only Editor process PID is invalid");
          assert.ok(Number.isSafeInteger(process.footprintBytes) && process.footprintBytes > 0,
            `hidden-only Editor process ${process.pid} footprint is invalid`);
        }
        assert.deepEqual((await s.get("core.surfaces")).filter((item) => item.plugin === "editor"), [],
          "Editor footprint acceptance left a live Editor surface");

        const evidence = { host: app.name, normalView, hiddenOnlyView: hiddenView.evidence,
          editorFootprint: hiddenView.editorFootprint };
        const directory = join(app.configDir, "logs", "editor-footprint");
        mkdirSync(directory, { recursive: true });
        const path = join(directory, `${app.name}.json`);
        writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
        t.diagnostic(`Editor process footprint evidence ${path}`);
      } catch (error) {
        operationError = error;
      }
      const cleanupErrors = [];
      try {
        if (normalClosed !== true) await closeEditorSurface(s, normalSurface);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (operationError !== undefined && cleanupErrors.length > 0) {
        throw new AggregateError([operationError, ...cleanupErrors], "Editor footprint acceptance and cleanup failed",
          { cause: operationError });
      }
      if (operationError !== undefined) throw operationError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Editor footprint acceptance cleanup failed");
    });
}
