import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectHwpStartupResourceEvidence } from "../hwp-startup.mjs";

function startupFixture(t, { startError, readError, stopError, clockValues = [100, 101] } = {}) {
  const calls = [];
  const evidence = { errors: [] };
  const saved = [];
  const root = mkdtempSync(join(tmpdir(), "hwp-startup-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "source-capture");
  const recordingCopyDirectory = join(root, "run", "capture-wailsv3");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(join(sourceDirectory, "frame-0001.bgra"), "raw-frame");
  writeFileSync(join(sourceDirectory, "recording.json"), JSON.stringify({ count: 1, time: 120 }));
  let clockIndex = 0;
  const s = {
    async run(name) {
      calls.push(name);
      if (name === "hwp.diagnostics.frames.start") {
        if (startError) throw startError;
        return { enabled: true, sequence: 4, width: 760, height: 286 };
      }
      if (name === "hwp.diagnostics.frames.read") {
        if (readError) throw readError;
        return { sequence: 4, width: 760, height: 286, resourceTimings: [],
          studioClock: { documentTimeOriginMs: 2000, snapshotAtMs: 25 } };
      }
      if (name === "hwp.diagnostics.frames.stop") {
        if (stopError) throw stopError;
        return { enabled: false, sequence: 4, studioViewport: null };
      }
      assert.fail(`unexpected command ${name}`);
    },
    async request(name) {
      calls.push(name);
      assert.equal(name, "diagnostics.clock");
      const mono_ns = String(clockValues[clockIndex++] * 1_000_000);
      return { mono_ns };
    },
  };
  const opened = {
    surface: "tab-hwp",
    requestAtMs: 90,
    processStart: { requestAtMs: 90, readyAtMs: 95 },
    recording: { directory: sourceDirectory, frameCount: 1 },
    async verifyContent() {
      calls.push("verify-content");
      const copiedFrame = join(recordingCopyDirectory, "frame-0001.bgra");
      assert.ok(existsSync(copiedFrame), "preserved recording copy must exist before offline OCR");
      assert.equal(readFileSync(copiedFrame, "utf8"), "raw-frame");
      assert.equal(readFileSync(join(recordingCopyDirectory, "recording.json"), "utf8"),
        JSON.stringify({ count: 1, time: 120 }), "recording metadata must be copied before offline OCR");
      return { contentFrame: { frameIndex: 7, frameCount: 12, timeMs: 140, proof: { expected: "body" } } };
    },
  };
  const persist = () => saved.push(JSON.parse(JSON.stringify(evidence)));
  return { calls, evidence, saved, s, opened, persist, recordingCopyDirectory, sourceDirectory };
}

test("HWP startup collection stops before offline content verification and preserves evidence", async (t) => {
  const fixture = startupFixture(t);
  await collectHwpStartupResourceEvidence(fixture.s, fixture.opened, {
    app: "wailsv3", path: "fixture/content.hwp", evidence: fixture.evidence, persist: fixture.persist,
    recordingCopyDirectory: fixture.recordingCopyDirectory,
  });

  assert.deepEqual(fixture.calls, [
    "hwp.diagnostics.frames.start", "diagnostics.clock", "hwp.diagnostics.frames.read",
    "diagnostics.clock", "hwp.diagnostics.frames.stop", "verify-content",
  ]);
  assert.equal(fixture.evidence.app, "wailsv3");
  assert.equal(fixture.evidence.path, "fixture/content.hwp");
  assert.equal(fixture.evidence.surface, "tab-hwp");
  assert.equal(fixture.evidence.requestAtMs, 90);
  assert.deepEqual(fixture.evidence.processStart, fixture.opened.processStart);
  assert.deepEqual(fixture.evidence.recording, { directory: fixture.recordingCopyDirectory,
    sourceDirectory: fixture.sourceDirectory, frameCount: 1 });
  assert.deepEqual(fixture.evidence.firstContent, {
    frameIndex: 7, frameCount: 12, timeMs: 140, proof: { expected: "body" }, elapsedMs: 50,
  });
  assert.ok(fixture.saved.length > 0, "collector did not persist collected evidence");
  rmSync(fixture.sourceDirectory, { recursive: true, force: true });
  assert.equal(readFileSync(join(fixture.recordingCopyDirectory, "frame-0001.bgra"), "utf8"), "raw-frame",
    "preserved recording must remain after the source capture is removed");
});

test("HWP startup read failure still stops tracing and retains offline verification", async (t) => {
  const failure = new Error("read failed");
  const fixture = startupFixture(t, { readError: failure });

  await assert.rejects(collectHwpStartupResourceEvidence(fixture.s, fixture.opened, {
    app: "wailsv3", path: "fixture/content.hwp", evidence: fixture.evidence, persist: fixture.persist,
    recordingCopyDirectory: fixture.recordingCopyDirectory,
  }), (error) => error === failure);

  assert.deepEqual(fixture.calls.slice(-2), ["hwp.diagnostics.frames.stop", "verify-content"]);
  assert.equal(fixture.evidence.errors[0]?.step, "read");
  assert.equal(fixture.evidence.firstContent?.timeMs, 140);
  assert.equal(fixture.evidence.stop?.enabled, false);
});

test("HWP startup collection rejects malformed monotonic clock metadata", async (t) => {
  const fixture = startupFixture(t, { clockValues: [101, 100] });

  await assert.rejects(collectHwpStartupResourceEvidence(fixture.s, fixture.opened, {
    app: "wailsv3", path: "fixture/content.hwp", evidence: fixture.evidence, persist: fixture.persist,
    recordingCopyDirectory: fixture.recordingCopyDirectory,
  }), /valid host monotonic bracket/);
  assert.ok(fixture.evidence.stop, "invalid clock metadata skipped trace cleanup");
  assert.ok(fixture.evidence.firstContent, "invalid clock metadata skipped offline verification");
});

test("HWP startup collection preserves start, stop, and offline verification errors", async (t) => {
  const startError = new Error("start failed");
  const stopError = new Error("stop failed");
  const fixture = startupFixture(t, { startError, stopError });
  fixture.opened.verifyContent = async () => {
    fixture.calls.push("verify-content");
    throw new Error("offline verification failed");
  };

  await assert.rejects(collectHwpStartupResourceEvidence(fixture.s, fixture.opened, {
    app: "wailsv3", path: "fixture/content.hwp", evidence: fixture.evidence, persist: fixture.persist,
    recordingCopyDirectory: fixture.recordingCopyDirectory,
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((item) => item.message), [
      "start failed", "stop failed", "offline verification failed",
    ]);
    return true;
  });
  assert.deepEqual(fixture.calls, ["hwp.diagnostics.frames.start", "hwp.diagnostics.frames.stop", "verify-content"]);
  assert.deepEqual(fixture.evidence.errors.map(({ step }) => step), ["start", "stop", "offline first-content verification"]);
  assert.equal(readFileSync(join(fixture.recordingCopyDirectory, "frame-0001.bgra"), "utf8"), "raw-frame",
    "raw recording must remain available when offline content verification fails");
  assert.equal(fixture.evidence.recording?.directory, fixture.recordingCopyDirectory,
    "recording evidence must point to its preserved copy after verification failure");
});

test("HWP startup collection reports a recording copy failure", async (t) => {
  const fixture = startupFixture(t);
  mkdirSync(fixture.recordingCopyDirectory, { recursive: true });
  writeFileSync(join(fixture.recordingCopyDirectory, "existing"), "do not overwrite");
  fixture.opened.verifyContent = async () => ({
    contentFrame: { frameIndex: 7, frameCount: 12, timeMs: 140, proof: { expected: "body" } },
  });

  await assert.rejects(collectHwpStartupResourceEvidence(fixture.s, fixture.opened, {
    app: "wailsv3", path: "fixture/content.hwp", evidence: fixture.evidence, persist: fixture.persist,
    recordingCopyDirectory: fixture.recordingCopyDirectory,
  }), (error) => error.code === "ERR_FS_CP_EEXIST");
  assert.equal(fixture.evidence.errors[0]?.step, "preserve source recording");
  assert.equal(readFileSync(join(fixture.recordingCopyDirectory, "existing"), "utf8"), "do not overwrite");
});
