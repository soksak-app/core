// Checks that opt-in captured-frame identity matches the current presented image of an image region. The image region is the raster
// probe, whose fake sidecar presents frames with their identity (generation, raster, sequence).
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh, joinedFailure, uncoverFromCheckWindows } from "./fixture.mjs";
import { addRasterTab, presentedFrame, presentRasterTab, REGION } from "./raster-probe.mjs";

const tuple = (value) => ({ generation: String(value.generation), raster: String(value.raster), sequence: value.sequence });

for (const app of Object.values(APPS)) {
  test(`${app.name}: opt-in capture identity matches the presented image of an image region`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { settings: { memorySaver: false } });
    // The check windows overlap and can cover this one whole; the identity codes are decoded from the captured pixels of the window,
    // so the window is uncovered before the capture.
    await uncoverFromCheckWindows(t, s);
    const targetCard = (await s.get("core.grid")).cards.find((item) => item.focused);
    assert.ok(targetCard, "the start layout has no focused card");
    // The capture starts with no visible image region, so the first image region that it sees is the one the check opens.
    await s.until("host.window", (host) => host.regions.every((region) => !region.visible),
      "an image region was visible before capture");
    await s.presented();

    const recording = await s.record({ frameIdentity: true });
    let stopResult;
    let stopAttempted = false;
    let operationError;
    let preservationError;
    let preserved;
    try {
      // The window draws its image regions covered from here on (presentRasterTab), as a check window opens behind other windows.
      const surface = await presentRasterTab(s, targetCard.id);
      await presentedFrame(s, surface);
      const presentation = await s.presented();
      const host = await s.until("host.window", (value) => value.regions.some((item) => item.surface === surface
        && item.name === REGION && item.visible && item.presented),
      `new raster probe ${surface} lost its presented image before capture stopped`);
      const region = host.regions.find((item) => item.surface === surface && item.name === REGION && item.visible);
      assert.ok(region?.presented, `new raster probe ${surface} has no presented image region: ${JSON.stringify(region)}`);
      const current = tuple(region.presented);

      stopAttempted = true;
      stopResult = await recording.stop({ after: presentation.displayed });
      assert.deepEqual(stopResult.frameIdentity && Object.keys(stopResult.frameIdentity).sort(), ["manifest", "status"],
        "opt-in stop did not return the declared frame-identity result");
      assert.equal(stopResult.frameIdentity.status, "complete");
      const manifestPath = stopResult.frameIdentity.manifest;
      assert.equal(manifestPath, join(recording.frames, "frame-identities", "manifest.json"));
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.format, 1);
      assert.equal(manifest.pixelFormat, "BGRA8");
      assert.equal(manifest.decodedFramesFile, "decoded-frames.jsonl");
      assert.ok(Number.isSafeInteger(manifest.decodedFrames) && manifest.decodedFrames > 0,
        "identity manifest reports no decoded frames");
      assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0,
        "identity capture wrote no tagged source raster");
      assert.equal(manifest.droppedArtifacts, 0);
      assert.equal(manifest.writeFailures, 0);
      assert.equal(manifest.cleanupFailures, 0);
      assert.equal(manifest.decodedWriteFailures, 0);
      assert.equal(manifest.identityFailure, null);

      for (const artifact of manifest.artifacts) {
        assert.equal(artifact.pixelFormat, "BGRA8");
        assert.equal(artifact.alpha, "premultiplied-first");
        const path = join(recording.frames, "frame-identities", artifact.file);
        assert.ok(existsSync(path), `tagged source artifact is missing: ${artifact.file}`);
        const bytes = readFileSync(path);
        assert.equal(bytes.length, artifact.byteCount, `tagged source byte count differs: ${artifact.file}`);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256,
          `tagged source digest differs: ${artifact.file}`);
      }

      const decodedPath = join(recording.frames, "frame-identities", manifest.decodedFramesFile);
      const rawDecoded = readFileSync(decodedPath, "utf8");
      const decoded = rawDecoded.trimEnd().split("\n").map((line) => JSON.parse(line));
      assert.equal(decoded.length, manifest.decodedRecords);
      assert.ok(decoded.length > 0, "capture produced no decoded sample records");
      for (const row of decoded) {
        assert.ok(Number.isSafeInteger(row.frame) && row.frame > 0, `invalid decoded frame number: ${JSON.stringify(row)}`);
        assert.match(row.displayTime, /^\d+$/, `invalid decoded display time: ${JSON.stringify(row)}`);
        assert.ok(row.region === null || typeof row.region === "string", `invalid decoded region: ${JSON.stringify(row)}`);
        assert.ok(row.roi === null || (row.roi && ["x", "y", "width", "height"].every((key) => Number.isFinite(row.roi[key]))),
          `invalid decoded ROI: ${JSON.stringify(row)}`);
        assert.ok(row.status === "matched" || row.status === "unknown", `invalid decoded status: ${JSON.stringify(row)}`);
        if (row.status === "matched") {
          assert.ok(row.identity && row.reason === null, `invalid matched identity row: ${JSON.stringify(row)}`);
        } else {
          assert.equal(row.identity, null, `unknown result retained an identity: ${JSON.stringify(row)}`);
          assert.ok(["no-code", "cropped", "ambiguous", "unissued", "unknown-retention", "unknown-geometry", "duplicate-roi"]
            .includes(row.reason), `unknown result has an undeclared reason: ${JSON.stringify(row)}`);
        }
      }
      const matched = decoded.filter((row) => row.status === "matched" && row.identity
        && typeof row.identity.generation === "string" && /^\d+$/.test(row.identity.generation)
        && typeof row.identity.raster === "string" && /^\d+$/.test(row.identity.raster)
        && Number.isSafeInteger(row.identity.sequence));
      if (matched.length === 0) {
        // The window state tells whether the captured window drew the view of the region: its surface, its native view element
        // and the frames of a workbench that draws its own frames.
        const { frames: drawn, commandBuffers, settled, surfaces, regions } = await s.get("host.window");
        const seat = (await s.get("core.surfaces")).find((item) => item.surface === surface);
        assert.fail(`capture decoded no issued source identity: ${rawDecoded}\nwindow after the capture: `
          + JSON.stringify({ regionsBeforeStop: host.regions, frames: drawn, commandBuffers, settled, surfaces, regions, seat }));
      }
      assert.ok(matched.some((row) => JSON.stringify(tuple(row.identity)) === JSON.stringify(current)),
        `no decoded sample matches the current presented image tuple ${JSON.stringify(current)}; `
          + `decoded identities: ${JSON.stringify(matched.map((row) => row.identity))}`);
      const artifacts = manifest.artifacts.map((artifact) => ({
        generation: artifact.generation, raster: artifact.raster, sequence: artifact.sequence,
      }));
      assert.ok(artifacts.some((identity) => JSON.stringify(identity) === JSON.stringify(current)),
        `no issued source artifact matches the current presented image tuple ${JSON.stringify(current)}; `
          + `artifact identities: ${JSON.stringify(artifacts)}`);
      assert.ok(matched.some((row) => JSON.stringify(tuple(row.identity)) === JSON.stringify(current)
        && artifacts.some((identity) => JSON.stringify(identity) === JSON.stringify(tuple(row.identity)))),
      "a decoded current tuple has no matching issued source artifact");
      t.diagnostic(`${app.name}: decoded ${matched.length} matched rows; current tuple ${JSON.stringify(current)}; `
        + `${decoded.length - matched.length} other rows retained without filtering`);
    } catch (error) {
      operationError = error;
    } finally {
      if (!stopAttempted) {
        stopAttempted = true;
        try {
          stopResult = await recording.stop({ after: 0 });
        } catch (error) {
          preservationError = error;
        }
      }
      try {
        const runFolder = process.env.SOKSAK_RUN_FOLDER;
        assert.ok(runFolder, "SOKSAK_RUN_FOLDER is required to preserve frame-identity evidence");
        preserved = join(runFolder, `${app.name}-frame-identity`);
        cpSync(recording.frames, preserved, { recursive: true });
        assert.ok(statSync(join(preserved, "frame-identities")).isDirectory(),
          "preserved evidence is missing the frame-identities directory");
        t.diagnostic(`${app.name}: preserved frame-identity evidence at ${preserved}`);
      } catch (error) {
        preservationError = preservationError ? joinedFailure("capture evidence preservation failed", [preservationError, error]) : error;
      }
    }
    if (operationError && preservationError) throw joinedFailure("frame-identity check and evidence preservation failed", [operationError, preservationError]);
    if (operationError) throw operationError;
    if (preservationError) throw preservationError;
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: diagnostic drag retains opt-in frame identity artifacts`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { settings: { memorySaver: false } });
    // A raster probe in the focused card gives the capture an image region whose frames carry their identity during the drag.
    await addRasterTab(s);
    const result = await drag(s,
      { axis: "x", line: 1, dx: 40, dy: 0, ms: 200, times: 1 },
      { capture: true, frameIdentity: true });
    assert.equal(result.frameIdentity?.status, "complete", "drag did not finalize requested frame identity");
    const manifestPath = join(result.frames, "frame-identities", "manifest.json");
    assert.equal(result.frameIdentity.manifest, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.format, 1);
    assert.ok(manifest.decodedFrames > 0, "drag identity capture contains no decoded frames");
    assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0,
      "drag identity capture contains no issued source artifacts");
    for (const field of ["droppedArtifacts", "writeFailures", "cleanupFailures", "decodedWriteFailures"]) {
      assert.equal(manifest[field], 0, `drag identity capture reported ${field}`);
    }
    assert.equal(manifest.identityFailure, null);
    for (const artifact of manifest.artifacts) {
      const file = join(result.frames, "frame-identities", artifact.file);
      const bytes = readFileSync(file);
      assert.equal(bytes.length, artifact.byteCount, `drag source byte count differs: ${artifact.file}`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256,
        `drag source digest differs: ${artifact.file}`);
    }
    t.diagnostic(`drag frame identity evidence ${manifestPath}`);
  });
}
