// Checks that opt-in captured-frame identity matches the current presented terminal image.
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { readScreenUntil } from "./terminal-screen.mjs";

const tuple = (value) => ({ generation: String(value.generation), raster: String(value.raster), sequence: value.sequence });

for (const app of Object.values(APPS)) {
  test(`${app.name}: opt-in capture identity matches the presented terminal image`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { settings: { memorySaver: false, "terminal.cursor.blink": "Never" } });
    const grid = await s.get("core.grid");
    const terminalCards = grid.cards.filter((item) => item.tabs.some((tab) => tab.plugin === "terminal"));
    assert.ok(terminalCards.length > 0, "the fixture has no terminal card");
    const originalTerminals = terminalCards.flatMap((card) => card.tabs.filter((tab) => tab.plugin === "terminal")
      .map((tab) => tab.id));
    for (const card of terminalCards) await s.run("core.card.add-tab", { card: card.id, plugin: "browser" });
    await s.until("core.surfaces", (items) => items.some((item) => item.visible && item.plugin === "browser")
      && originalTerminals.every((surface) => !items.some((item) => item.surface === surface && item.visible)),
    "existing terminal surfaces remained visible after selecting browser tabs");
    await s.until("host.window", (host) => originalTerminals.every((surface) => host.regions
      .every((region) => region.surface !== surface || region.name !== "view" || !region.visible)),
    "an existing terminal image region remained visible before capture");
    await s.presented();

    const recording = await s.record({ frameIdentity: true });
    let stopResult;
    let stopAttempted = false;
    let operationError;
    let preservationError;
    let preserved;
    try {
      const { tab: surface } = await s.run("core.card.add-tab", { card: card.id, plugin: "terminal" });
      await s.until("core.grid", (value) => value.cards.some((item) => item.id === card.id && item.active === surface),
        `new terminal ${surface} did not become the active card tab`);
      const visible = await s.until("core.surfaces", (items) => items.find((item) => item.surface === surface
        && item.plugin === "terminal" && item.visible
        && item.exposes.includes("status terminal.session")),
      `new terminal ${surface} did not become a visible declared surface`);
      assert.ok(visible, `new terminal ${surface} is not visible`);
      await s.until("terminal.session", (state) => Boolean(state?.sessionId),
        `new terminal ${surface} did not open its session`, { surface });
      const firstImage = await s.until("host.window", (host) => host.regions.some((item) => item.surface === surface
        && item.name === "view" && item.visible && item.presented),
      `new terminal ${surface} did not present an image region`);
      assert.ok(firstImage.regions.some((item) => item.surface === surface && item.name === "view"
        && item.visible && item.presented), `new terminal ${surface} image was not presented`);
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith("sh-")),
        `new terminal ${surface} did not display the shell prompt`);
      const presentation = await s.presented();
      const host = await s.until("host.window", (value) => value.regions.some((item) => item.surface === surface
        && item.name === "view" && item.visible && item.presented),
      `new terminal ${surface} lost its presented image before capture stopped`);
      const region = host.regions.find((item) => item.surface === surface && item.name === "view" && item.visible);
      assert.ok(region?.presented, `new terminal ${surface} has no presented image region: ${JSON.stringify(region)}`);
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
      assert.ok(matched.length > 0, `capture decoded no issued source identity: ${rawDecoded}`);
      assert.ok(matched.some((row) => JSON.stringify(tuple(row.identity)) === JSON.stringify(current)),
        `no decoded sample matches the current presented terminal tuple ${JSON.stringify(current)}; `
          + `decoded identities: ${JSON.stringify(matched.map((row) => row.identity))}`);
      const artifacts = manifest.artifacts.map((artifact) => ({
        generation: artifact.generation, raster: artifact.raster, sequence: artifact.sequence,
      }));
      assert.ok(artifacts.some((identity) => JSON.stringify(identity) === JSON.stringify(current)),
        `no issued source artifact matches the current presented terminal tuple ${JSON.stringify(current)}; `
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
        preservationError = preservationError ? new AggregateError([preservationError, error], "capture evidence preservation failed") : error;
      }
    }
    if (operationError && preservationError) throw new AggregateError([operationError, preservationError], "frame-identity check and evidence preservation failed");
    if (operationError) throw operationError;
    if (preservationError) throw preservationError;
  });
}
