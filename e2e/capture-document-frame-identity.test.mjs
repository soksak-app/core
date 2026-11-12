// Checks that captured ScreenCaptureKit pixels carry the identity of a live plugin root WebKit document. The document is the root
// document of a `layoutprobe2` tab, a view without regions, so no native child region covers it.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows } from "@soksak/window-check/event-log.mjs";
import { fresh, joinedFailure } from "./fixture.mjs";
import { documentIdentityCardIds, verifyDocumentFrameIdentityCapture, viewGenerationForSurface } from "./document-frame-identity.mjs";

/** The fixture plugin whose root document the capture identifies: a view without regions. */
const ROOT_VIEW = "layoutprobe2";

for (const app of Object.values(APPS)) {
  test(`${app.name}: document-frame identity matches captured WebKit root pixels`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { performanceTrace: true });
    // Every card shows a tab of the view without regions, so no native region of another tab covers the identity ROI.
    const grid = await s.get("core.grid");
    const offsets = currentEventOffsets(s.app.configDir);
    let opened;
    for (const card of documentIdentityCardIds(grid)) {
      const { tab } = await s.run("core.card.add-tab", { card, plugin: ROOT_VIEW });
      if (card === grid.cards.find((item) => item.focused)?.id) opened = { tab };
    }
    assert.equal(typeof opened?.tab, "string", "no tab of the focused card holds the root view");
    const visible = await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === opened.tab && item.plugin === ROOT_VIEW && item.visible
        && item.exposes.includes("status core.surface.document")),
    `root view surface ${opened.tab} did not become visible`);
    assert.ok(visible, `root view surface ${opened.tab} is not visible`);
    await s.until("core.surface.document", (document) => document?.readyState === "complete",
      `root view surface ${opened.tab} did not load its document`, { surface: opened.tab });
    await s.presented();

    await s.flushLog();
    const trace = traceRows(readEvents(s.app.configDir, offsets).events);
    const generation = viewGenerationForSurface(trace, opened.tab);
    const host = await s.get("host.window");
    const rootDocument = host.documents.find((item) => item.surface === opened.tab && item.document === "" && item.visible);
    assert.ok(rootDocument, `root view surface ${opened.tab} has no visible native WebKit root document`);
    assert.ok(host.regions.every((region) => !region.visible),
      `a visible native child region can cover the document identity ROI: ${JSON.stringify(host.regions.filter((region) => region.visible))}`);

    const recording = await s.record({ frameIdentity: true });
    let stopAttempted = false;
    let result;
    let operationError;
    let cleanupError;
    try {
      const started = await s.request("diagnostics.capture.document-identity.start", {
        surface: opened.tab, generation,
      });
      assert.equal(started.surface, opened.tab, "document identity start replied for a different surface");
      assert.equal(started.generation, generation, "document identity start replied for a different view generation");
      assert.ok(Number.isSafeInteger(started.atlasSlots) && started.atlasSlots >= 1 && started.atlasSlots <= 512,
        `document identity start reported an invalid atlas capacity: ${JSON.stringify(started.atlasSlots)}`);
      assert.ok(started.roi && ["x", "y", "width", "height", "scale"].every((key) => Number.isFinite(started.roi[key]))
        && started.roi.width > 0 && started.roi.height > 0 && started.roi.scale > 0,
      `document identity start returned invalid measured WebKit ROI: ${JSON.stringify(started.roi)}`);

      const presentation = await s.presented();
      stopAttempted = true;
      result = await recording.stop({ after: presentation.displayed });
      assert.equal(result.frameIdentity?.status, "complete", "capture did not finalize document identity evidence");
      const manifestPath = result.frameIdentity.manifest;
      assert.equal(manifestPath, join(recording.frames, "frame-identities", "manifest.json"));
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const decodedPath = join(dirname(manifestPath), manifest.decodedFramesFile);
      const decodedRows = readFileSync(decodedPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      const identity = verifyDocumentFrameIdentityCapture({
        start: started,
        stop: result,
        manifest,
        decodedRows,
        surface: opened.tab,
        generation,
      });
      const atlasPath = join(dirname(manifestPath), manifest.documentFrameIdentity.atlasFile);
      assert.equal(manifest.documentFrameIdentity.atlasFile, "document-atlas.png");
      assert.ok(existsSync(atlasPath), `document QR atlas is missing: ${atlasPath}`);
      assert.deepEqual(readFileSync(atlasPath).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        "document identity atlas is not a PNG image");

      t.diagnostic(`${app.name}: document identity generation ${generation}; `
        + `${identity.matchedRecords} matched / ${identity.unknownRecords} unknown document rows; manifest ${manifestPath}`);
    } catch (error) {
      operationError = error;
    } finally {
      if (!stopAttempted) {
        stopAttempted = true;
        try {
          result = await recording.stop({ after: 0 });
        } catch (error) {
          cleanupError = error;
        }
      }
      try {
        const runFolder = process.env.SOKSAK_RUN_FOLDER;
        assert.ok(runFolder, "SOKSAK_RUN_FOLDER is required to preserve document identity evidence");
        mkdirSync(runFolder, { recursive: true });
        const preserved = join(runFolder, `${app.name}-document-frame-identity`);
        cpSync(recording.frames, preserved, { recursive: true });
        t.diagnostic(`${app.name}: preserved document identity capture at ${preserved}`);
      } catch (error) {
        cleanupError = cleanupError ? joinedFailure("document identity evidence preservation failed", [cleanupError, error]) : error;
      }
    }
    if (operationError && cleanupError) throw joinedFailure("document identity check and cleanup failed", [operationError, cleanupError]);
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
  });
}
