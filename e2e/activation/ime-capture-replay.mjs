import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { capturesByInputStage, evaluateVisualStages, indexAcceptedFrameTrace,
  persistThenRequireVisualProof, attachImeFrameIdentities,
  planVisualStage, readImeFrameIdentities, readRetainedSources, sealTerminalSequenceEndBoundary }
  from "./ime-visual-capture.mjs";
import { terminalInputReceiptMatches } from "./terminal-ime-document.mjs";

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonLines(path) {
  const text = readFileSync(path, "utf8");
  assert.notEqual(text.trim(), "", `${path}: file is empty`);
  return text.trim().split("\n").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}: line ${index + 1} is invalid JSON: ${error.message}`);
    }
  });
}

export function parseReplayArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    assert.ok(["--artifact-dir", "--result-file"].includes(name), `unsupported argument ${String(name)}`);
    assert.ok(typeof value === "string" && value.length > 0, `${name} requires a path`);
    assert.ok(!values.has(name), `${name} was provided more than once`);
    values.set(name, value);
  }
  assert.ok(values.has("--artifact-dir"), "--artifact-dir is required");
  assert.ok(values.has("--result-file"), "--result-file is required");
  return { artifactDir: resolve(values.get("--artifact-dir")), resultFile: resolve(values.get("--result-file")) };
}

export function replayImeCapture({ artifactDir, resultFile }) {
  assert.ok(typeof artifactDir === "string" && artifactDir.length > 0, "an explicit artifact directory is required");
  assert.ok(typeof resultFile === "string" && resultFile.length > 0, "an explicit result file is required");
  const directory = resolve(artifactDir);
  const output = resolve(resultFile);
  assert.ok(existsSync(directory), `artifact directory does not exist: ${directory}`);
  assert.ok(!existsSync(output), `result file already exists: ${output}`);

  const manifest = json(join(directory, "manifest.json"));
  const recording = json(join(directory, "recording.json"));
  const stages = json(join(directory, "visual-stage-inputs.json"));
  const terminalEnd = json(join(directory, "terminal-sequence-end-boundary.json"));
  const frameEvents = json(join(directory, "frame-state-log-events.json"));
  const nativeInput = json(join(directory, "native-input-events.json"));
  const frameSession = frameEvents.find((event) => event.event === "plugin.terminal.frame")?.fields?.session;
  assert.equal(nativeInput.flushError, null, "native input trace flush failed");
  assert.ok(typeof frameSession === "string" && frameSession.length > 0,
    "frame trace has no terminal session identity");
  assert.deepEqual(manifest.sequence, [...Array(8).fill("k"), "Backspace", "Space"],
    "artifact does not contain the approved eight-k, Backspace, Space sequence");
  assert.equal(manifest.steps.length, 20, "artifact does not contain all reference and terminal key steps");
  assert.equal(stages.length, 10, "artifact does not contain all ten visual stages");
  assert.equal(manifest.recording, recording.frames, "manifest and recording paths differ");
  assert.equal(manifest.sourceRecording, recording.sourceFrames, "manifest and source recording paths differ");
  assert.equal(recording.limited, false, "recording reached its frame limit");
  assert.ok(Number.isSafeInteger(recording.count) && recording.count > 0, "recording frame count is invalid");

  const expectedKeys = [...Array(8).fill("k"), "Backspace", "Space"];
  const terminalKeyEvents = nativeInput.events.filter((event) => event.event === "native.input.key_down");
  assert.equal(terminalKeyEvents.length, 10, "native input trace does not contain ten key-down records");
  const comparisons = [];
  for (let index = 1; index <= 10; index++) {
    const suffix = String(index).padStart(2, "0");
    const key = expectedKeys[index - 1];
    const reference = json(join(directory, `reference-${suffix}.json`));
    const comparison = json(join(directory, `comparison-${suffix}.json`));
    const stage = stages[index - 1];
    assert.equal(reference.group, "reference", `reference ${suffix} has the wrong group`);
    assert.equal(reference.index, index, `reference ${suffix} has the wrong index`);
    assert.equal(reference.key, key, `reference ${suffix} has the wrong key`);
    assert.equal(reference.state.open, true, `reference ${suffix} is not open`);
    assert.equal(reference.state.focused, true, `reference ${suffix} is not focused`);
    assert.equal(comparison.key, key, `comparison ${suffix} has the wrong key`);
    assert.equal(comparison.expected, reference.state.document, `comparison ${suffix} differs from AppKit document`);
    assert.equal(comparison.actual, comparison.expected, `terminal document differs at ${key}-${index}`);
    assert.equal(stage.key, index <= 8 ? `k-${index}` : key, `visual stage ${index} has the wrong key`);
    assert.equal(stage.expectedDocument, comparison.expected, `visual stage ${index} differs from its comparison`);
    assert.deepEqual(comparison.terminal, stage.observation, `terminal observation ${index} differs from its saved stage`);
    assert.ok(terminalInputReceiptMatches(comparison.terminalInputs, key),
      `terminal trace has no matching input receipt for ${key}-${index}`);
    comparisons.push({ index, key, expected: comparison.expected, actual: comparison.actual,
      receiptCount: comparison.terminalInputs.length });
  }
  const finalReference = json(join(directory, "reference-final.json"));
  assert.equal(finalReference.document, comparisons.at(-1).expected,
    "final AppKit reference differs from the Space comparison");
  assert.equal(finalReference.focused, true, "final AppKit reference is not focused");
  assert.equal(nativeInput.events.filter((event) => event.event === "native.input.callback").length > 0, true,
    "native input trace has no callback records");

  const sealedStages = sealTerminalSequenceEndBoundary(manifest.terminalSequenceEndBoundary, stages, () => {});
  assert.deepEqual(terminalEnd.stages, sealedStages, "saved terminal stage boundaries differ from the manifest");
  const frameStatus = indexAcceptedFrameTrace(frameEvents, manifest.prompt, manifest.surface, frameSession);
  const sourceDirectory = recording.sourceFrames;
  const sourcesResult = readRetainedSources(sourceDirectory, frameStatus);
  const visualStages = stages.map((stage) => ({ ...planVisualStage({ ...stage, frameStatus }),
    clockDomain: stage.clockDomain, startedMachAbsoluteNs: stage.startedMachAbsoluteNs,
    endedMachAbsoluteNs: sealedStages.find(({ key }) => key === stage.key)?.endedMachAbsoluteNs }));

  const framePaths = frames(recording.frames);
  const callbackStatusPath = recording.callbackStatus;
  const callbackStatus = jsonLines(callbackStatusPath);
  assert.ok(callbackStatus.length <= 4096, "capture callback trace exceeds its declared capacity");
  callbackStatus.forEach((callback, index) => {
    assert.equal(callback.sequence, index + 1, `capture callback sequence has a gap at ${index + 1}`);
    for (const field of ["callbackTime", "writeStartTime", "writeCompleteTime"])
      assert.ok(typeof callback[field] === "string" && /^\d+$/.test(callback[field]),
        `capture callback ${field} is missing or invalid`);
    assert.ok(callback.frame === null || typeof callback.frame === "string", "capture callback frame is invalid");
    if (callback.frame !== null) {
      assert.equal(callback.status, 0, `capture callback ${callback.frame} is incomplete`);
      assert.ok(typeof callback.displayTime === "string" && /^\d+$/.test(callback.displayTime),
        `capture callback ${callback.frame} has no display time`);
    }
  });
  const frameCallbacks = callbackStatus.flatMap((callback, index) => callback.frame === null ? [] : [{ callback, index }]);
  assert.equal(frameCallbacks.length, recording.count, "callback count differs from the recording manifest");
  assert.equal(framePaths.length, recording.count, "frame files differ from the recording manifest");
  assert.deepEqual(frameCallbacks.map(({ callback }) => callback.frame), framePaths.map((path) => basename(path)),
    "capture callback frame names differ from recorded files");
  if (recording.frameFiles) assert.deepEqual(recording.frameFiles, framePaths.map((path) => basename(path)),
    "recording frame file list differs from the retained files");

  const identityCapture = readImeFrameIdentities(sourceDirectory, recording);
  const identityRowsByFrame = attachImeFrameIdentities(frameCallbacks, framePaths, identityCapture);
  const decoded = framePaths.map(readFrame);
  assert.equal(decoded.length, recording.count, "decoded capture frame count differs from the recording manifest");
  const frameGaps = decoded.slice(1).map((frame, index) => ({
    from: basename(framePaths[index]), to: basename(framePaths[index + 1]),
    milliseconds: frame.time - decoded[index].time,
  }));
  const longestFrameGap = Math.max(...frameGaps.map(({ milliseconds }) => milliseconds));
  assert.equal(longestFrameGap, recording.longestFrameGap,
    "replayed frame cadence differs from the preserved recording metrics");

  const groupedCaptures = capturesByInputStage(frameCallbacks.map(({ callback }) => ({
    name: callback.frame, callback, identityRows: identityRowsByFrame.get(callback.frame),
  })), decoded, visualStages);
  const visualMeasurements = visualStages.map((stage) => evaluateVisualStages({
    captures: groupedCaptures.get(stage.key), sources: sourcesResult.sources, stages: [stage],
    criteria: { colorDistance: 32, minimumGlyphPixels: 2, minimumUnderlineCoverage: 0.75 },
    tagArtifacts: identityCapture.artifactRecords, statusConflicts: frameStatus.conflicts,
  })[0]);
  const glyphProof = visualMeasurements.every((measurement) => measurement.tagScoped?.result === "measured");
  const result = {
    artifactDir: directory,
    app: manifest.app,
    shellFixture: manifest.shellFixture,
    sequence: manifest.sequence,
    testedBinary: "the preserved run manifest records app and capture files; no executable hash is embedded in this artifact",
    referenceAndTerminalChecks: { count: comparisons.length, pass: comparisons.every(({ expected, actual }) => expected === actual), comparisons },
    sourceJoin: { retainedCount: sourcesResult.sources.length, missingSourceStates: sourcesResult.missingStates,
      conflictingFrames: [...frameStatus.conflicts.values()], unjoinedMessages: frameStatus.unjoinedMessages,
      noRasterMessages: frameStatus.noRasterMessages },
    tagIdentities: { issued: identityCapture.artifacts.length, decodedFrames: identityCapture.decodedFrames,
      unknownRecords: identityCapture.unknownRecords.length },
    captureFrames: decoded.length,
    glyphProof: { passed: glyphProof, measurements: visualMeasurements },
    cadence: { longestFrameGap, frameGaps },
    overallAccepted: glyphProof && comparisons.length === 10 &&
      comparisons.every(({ expected, actual }) => expected === actual),
  };
  let acceptanceError = null;
  try {
    persistThenRequireVisualProof(visualMeasurements, { cadence: result.cadence },
      () => writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" }), "offline IME replay");
  } catch (error) {
    acceptanceError = error;
  }
  if (acceptanceError) {
    process.stderr.write(`${acceptanceError.stack ?? acceptanceError.message}\n`);
    return { ...result, acceptanceError: { name: acceptanceError.name, message: acceptanceError.message }, resultFile: output };
  }
  return { ...result, resultFile: output };
}

async function main() {
  const args = parseReplayArgs(process.argv.slice(2));
  const result = replayImeCapture(args);
  process.stdout.write(`${JSON.stringify({ resultFile: result.resultFile, app: result.app, shellFixture: result.shellFixture,
    comparisons: result.referenceAndTerminalChecks.count, referencesAndTerminalMatch: result.referenceAndTerminalChecks.pass,
    retainedSources: result.sourceJoin.retainedCount, missingSourceStates: result.sourceJoin.missingSourceStates.length,
    captureFrames: result.captureFrames, glyphProof: result.glyphProof.passed,
    cadence: { longestFrameGap: result.cadence.longestFrameGap,
      maximumFrameGap: result.cadence.maximumFrameGap, frameGapCount: result.cadence.frameGaps.length,
      passed: result.cadence.passed }, overallAccepted: result.overallAccepted })}\n`);
  if (!result.overallAccepted) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
