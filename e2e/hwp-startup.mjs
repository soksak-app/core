import assert from "node:assert/strict";
import { cpSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { monotonicTimeMs } from "./view-metrics-collection.mjs";

/** Collects HWP startup resource state after opening and before the E2E cleanup removes its recording. */
export async function collectHwpStartupResourceEvidence(s, opened, {
  app, path, evidence, persist, recordingCopyDirectory,
}) {
  assert.ok(s && typeof s.run === "function" && typeof s.request === "function",
    "HWP startup collection requires a window-check session");
  assert.ok(opened && typeof opened.surface === "string" && opened.surface.length > 0,
    "HWP startup collection requires an opened view");
  assert.ok(Number.isFinite(opened.requestAtMs), "HWP startup collection requires the original request time");
  assert.equal(typeof opened.verifyContent, "function", "HWP startup collection requires deferred content verification");
  assert.ok(typeof opened.recording?.directory === "string" && opened.recording.directory.length > 0,
    "HWP startup collection requires the source recording directory");
  assert.ok(Number.isSafeInteger(opened.recording.frameCount) && opened.recording.frameCount > 0,
    "HWP startup collection requires the source recording frame count");
  assert.ok(typeof recordingCopyDirectory === "string" && recordingCopyDirectory.length > 0,
    "HWP startup collection requires a preserved recording directory");
  assert.equal(typeof persist, "function", "HWP startup collection requires an evidence persistence callback");
  assert.ok(evidence && Array.isArray(evidence.errors), "HWP startup collection requires an evidence object with errors");

  evidence.app = app;
  evidence.path = path;
  evidence.surface = opened.surface;
  evidence.requestAtMs = opened.requestAtMs;
  evidence.processStart = opened.processStart;
  evidence.sourceRecording = opened.recording.directory;
  evidence.recording = { sourceDirectory: opened.recording.directory, frameCount: opened.recording.frameCount };
  persist();

  const failures = [];
  const recordFailure = (step, error) => {
    failures.push({ step, error });
    evidence.errors.push({ step, message: String(error?.message ?? error) });
    persist();
  };

  let startAttempted = false;
  try {
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
    recordFailure("start", error);
  } finally {
    if (startAttempted) {
      try {
        evidence.stop = await s.run("hwp.diagnostics.frames.stop", {}, opened.surface);
        persist();
      } catch (error) {
        recordFailure("stop", error);
      }
    }
  }

  try {
    mkdirSync(dirname(recordingCopyDirectory), { recursive: true });
    cpSync(opened.recording.directory, recordingCopyDirectory, { recursive: true, errorOnExist: true, force: false });
    evidence.recording = { directory: recordingCopyDirectory, sourceDirectory: opened.recording.directory,
      frameCount: opened.recording.frameCount };
    persist();
  } catch (error) {
    recordFailure("preserve source recording", error);
  }

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

  if (failures.length === 1) throw failures[0].error;
  if (failures.length > 1) {
    throw new AggregateError(failures.map(({ error }) => error),
      `HWP startup resource evidence failed at ${failures.map(({ step }) => step).join(", ")}`);
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
  assert.equal(evidence.recording?.directory, recordingCopyDirectory,
    "HWP resource timing recording manifest does not reference the preserved recording copy");
  return evidence;
}
