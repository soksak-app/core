import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const TOTAL_MARGIN_BYTES = 10_000_000;
const RECLAIM_FRACTION = 0.9;
const RECLAIM_LIMIT_MS = 10_000;
const FIRST_DISPLAY_MARGIN_MS = 300;
const PROCESS_START_SAMPLES = 5;
const NEW_PROCESS_RUNS = 3;
const LAYOUT_DISPLAY_LIMIT_MS = 100;
const DRAG_GEOMETRY_LIMIT_PT = 2;
const DRAG_CONTENT_INTERVAL_LIMIT_MS = 33;
const DRAG_SETTLE_FRAME_LIMIT = 2;
const EDITOR_SIDECAR_THRESHOLD_BYTES = 50_000_000;

function fail(path, expected, found) {
  throw new Error(`view measurement ${path}: expected ${expected}, found ${JSON.stringify(found)}`);
}

function objectAt(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "an object", value);
  return value;
}

function arrayAt(value, path, { length, minimum = 0 } = {}) {
  if (!Array.isArray(value)) fail(path, "an array", value);
  if (length !== undefined && value.length !== length) fail(path, `exactly ${length} entries`, value.length);
  if (value.length < minimum) fail(path, `at least ${minimum} entries`, value.length);
  return value;
}

function textAt(value, path) {
  if (typeof value !== "string" || value.length === 0) fail(path, "nonempty text", value);
  return value;
}

function numberAt(value, path, { minimum = 0, integer = false } = {}) {
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
    fail(path, `${integer ? "a safe integer" : "a finite number"} >= ${minimum}`, value);
  }
  return value;
}

function pidAt(value, path) {
  const validNumber = Number.isSafeInteger(value) && value > 0;
  const validText = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) &&
    Number.isSafeInteger(Number(value)) && Number(value) > 0;
  if (!validNumber && !validText) {
    fail(path, "a positive process identifier", value);
  }
  return value;
}

function sameValue(left, right, path) {
  if (left !== right) fail(path, `the same value in both observations (${JSON.stringify(left)})`, right);
}

function processFootprints(value, path, { allowEmpty = false } = {}) {
  const processes = arrayAt(value, path, { minimum: allowEmpty ? 0 : 1 });
  const ids = new Set();
  let totalBytes = 0;
  for (const [index, process] of processes.entries()) {
    objectAt(process, `${path}[${index}]`);
    const pid = pidAt(process.pid, `${path}[${index}].pid`);
    if (ids.has(pid)) fail(`${path}[${index}].pid`, "a process identifier not already measured", pid);
    ids.add(pid);
    totalBytes += numberAt(process.footprintBytes, `${path}[${index}].footprintBytes`, { integer: true });
    if (!Number.isSafeInteger(totalBytes)) fail(path, "a safely summable footprint", totalBytes);
  }
  return { processes, ids, totalBytes };
}

function frameAt(value, path, { recordedFrameCount, requireProof = false } = {}) {
  objectAt(value, path);
  const frameIndex = numberAt(value.frameIndex, `${path}.frameIndex`, { integer: true });
  if (recordedFrameCount !== undefined && frameIndex >= recordedFrameCount) {
    fail(`${path}.frameIndex`, `less than recordedFrameCount ${recordedFrameCount}`, frameIndex);
  }
  if (value.frameCount !== undefined) {
    const frameCount = numberAt(value.frameCount, `${path}.frameCount`, { minimum: 1, integer: true });
    if (frameIndex >= frameCount) fail(`${path}.frameIndex`, `less than frameCount ${frameCount}`, frameIndex);
    if (recordedFrameCount !== undefined) sameValue(frameCount, recordedFrameCount, `${path}.frameCount`);
  } else if (requireProof) {
    fail(`${path}.frameCount`, "the recorded frame count for pixel proof", value.frameCount);
  }
  const timeMs = numberAt(value.timeMs, `${path}.timeMs`);
  if (requireProof) contentProofAt(value.proof, `${path}.proof`);
  return { frameIndex, timeMs };
}

function contentProofAt(value, path) {
  objectAt(value, path);
  const expected = textAt(value.expected, `${path}.expected`).trim();
  const actual = textAt(value.actual, `${path}.actual`);
  const lines = arrayAt(value.lines, `${path}.lines`, { minimum: 1 });
  for (const [index, line] of lines.entries()) textAt(line, `${path}.lines[${index}]`);
  assert.ok(actual.toLowerCase().includes(expected.toLowerCase()),
    `view measurement ${path}.actual does not contain the expected text ${JSON.stringify(expected)}`);
}

function rectAt(value, path, { allowNegative = false } = {}) {
  objectAt(value, path);
  const minimum = allowNegative ? -Number.MAX_VALUE : 0;
  const rect = {};
  for (const edge of ["left", "top", "right", "bottom"]) {
    rect[edge] = numberAt(value[edge], `${path}.${edge}`, { minimum });
  }
  if (rect.right < rect.left) fail(`${path}.right`, `>= left edge ${rect.left}`, rect.right);
  if (rect.bottom < rect.top) fail(`${path}.bottom`, `>= top edge ${rect.top}`, rect.bottom);
  return rect;
}

function slotInsetsAt(value, path) {
  objectAt(value, path);
  const insets = {};
  for (const edge of ["left", "top", "right", "bottom"]) {
    insets[edge] = numberAt(value[edge], `${path}.${edge}`);
  }
  return insets;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function assertIncreasing(values, path) {
  for (let index = 1; index < values.length; index++) {
    if (values[index] <= values[index - 1]) fail(`${path}[${index}]`, `greater than prior value ${values[index - 1]}`, values[index]);
  }
}

function displayAt(value, path) {
  objectAt(value, path);
  const requestAtMs = numberAt(value.requestAtMs, `${path}.requestAtMs`);
  const contentFrame = frameAt(value.contentFrame, `${path}.contentFrame`, { requireProof: true });
  const measuredMs = contentFrame.timeMs - requestAtMs;
  if (measuredMs < 0) fail(`${path}.contentFrame.timeMs`, `>= requestAtMs ${requestAtMs}`, contentFrame.timeMs);
  return { requestAtMs, contentFrame, measuredMs };
}

function evaluateTotal(value) {
  const total = objectAt(value, "total");
  const viewCount = numberAt(total.viewCount, "total.viewCount", { minimum: 2, integer: true });
  const oneView = processFootprints(total.oneViewProcesses, "total.oneViewProcesses");
  const allViews = processFootprints(total.allViewProcesses, "total.allViewProcesses");
  if (oneView.totalBytes <= 0) fail("total.oneViewProcesses", "a positive measured process-group footprint", oneView.totalBytes);
  if (allViews.totalBytes <= 0) fail("total.allViewProcesses", "a positive measured process-group footprint", allViews.totalBytes);
  const limitBytes = viewCount * oneView.totalBytes + TOTAL_MARGIN_BYTES;
  if (!Number.isSafeInteger(limitBytes)) fail("total.limitBytes", "a safely computed footprint limit", limitBytes);
  assert.ok(allViews.totalBytes <= limitBytes,
    `view measurement total.allViewProcesses sums to ${allViews.totalBytes} bytes, exceeding ${viewCount} × ` +
    `${oneView.totalBytes} + ${TOTAL_MARGIN_BYTES} = ${limitBytes} bytes`);
  return { viewCount, oneViewBytes: oneView.totalBytes, allViewsBytes: allViews.totalBytes, limitBytes, passed: true };
}

function evaluateReclaim(value) {
  const runs = arrayAt(value, "reclaim", { length: 3 });
  return runs.map((run, index) => {
    const path = `reclaim[${index}]`;
    objectAt(run, path);
    const before = processFootprints(run.beforeProcesses, `${path}.beforeProcesses`);
    const after = processFootprints(run.afterProcesses, `${path}.afterProcesses`);
    if (before.ids.size !== after.ids.size || [...before.ids].some((pid) => !after.ids.has(pid))) {
      fail(`${path}.afterProcesses`, `the same process identities as ${path}.beforeProcesses`, after.processes);
    }
    if (before.totalBytes < 1) fail(`${path}.beforeProcesses`, "a positive complete-group footprint", before.totalBytes);
    if (typeof run.engineCacheHeld !== "boolean") fail(`${path}.engineCacheHeld`, "a boolean", run.engineCacheHeld);
    assert.equal(run.engineCacheHeld, false,
      `view measurement ${path}.engineCacheHeld is true; an engine-cached process counts as not returned`);
    const closedViews = arrayAt(run.closedViews, `${path}.closedViews`, { minimum: 1 });
    for (const [viewIndex, view] of closedViews.entries()) {
      const viewPath = `${path}.closedViews[${viewIndex}]`;
      objectAt(view, viewPath);
      textAt(view.surface, `${viewPath}.surface`);
      if (numberAt(view.rootHistoryEntries, `${viewPath}.rootHistoryEntries`, { integer: true }) !== 1) {
        fail(`${viewPath}.rootHistoryEntries`, "exactly 1 root view history entry", view.rootHistoryEntries);
      }
      const documents = arrayAt(view.documents, `${viewPath}.documents`);
      const documentNames = new Set();
      for (const [documentIndex, document] of documents.entries()) {
        const documentPath = `${viewPath}.documents[${documentIndex}]`;
        objectAt(document, documentPath);
        const name = textAt(document.document, `${documentPath}.document`);
        if (documentNames.has(name)) fail(`${documentPath}.document`, "a document name not already measured", name);
        documentNames.add(name);
        if (numberAt(document.historyEntries, `${documentPath}.historyEntries`, { integer: true }) !== 1) {
          fail(`${documentPath}.historyEntries`, "exactly 1 initial document history entry", document.historyEntries);
        }
      }
    }
    const elapsedMs = numberAt(run.elapsedMs, `${path}.elapsedMs`);
    const returnedFraction = (before.totalBytes - after.totalBytes) / before.totalBytes;
    assert.ok(elapsedMs <= RECLAIM_LIMIT_MS,
      `view measurement ${path}.elapsedMs ${elapsedMs} exceeds ${RECLAIM_LIMIT_MS} ms`);
    assert.ok(returnedFraction >= RECLAIM_FRACTION,
      `view measurement ${path} returned ${(returnedFraction * 100).toFixed(3)}%, below 90%`);
    return { beforeBytes: before.totalBytes, afterBytes: after.totalBytes, elapsedMs, returnedFraction, passed: true };
  });
}

function evaluateWarmDisplay(value, baselineMs) {
  const warm = objectAt(value, "warmDisplay");
  textAt(warm.surface, "warmDisplay.surface");
  const beforePids = arrayAt(warm.beforePids, "warmDisplay.beforePids", { minimum: 0 }).map((pid, index) =>
    pidAt(pid, `warmDisplay.beforePids[${index}]`));
  if (new Set(beforePids).size !== beforePids.length) fail("warmDisplay.beforePids", "unique process identifiers", beforePids);
  const beforePidsAtMs = numberAt(warm.beforePidsAtMs, "warmDisplay.beforePidsAtMs");
  const requestAtMs = numberAt(warm.requestAtMs, "warmDisplay.requestAtMs");
  if (beforePidsAtMs > requestAtMs) {
    fail("warmDisplay.beforePidsAtMs", `<= requestAtMs ${requestAtMs}`, beforePidsAtMs);
  }
  const openedPid = pidAt(warm.openedPid, "warmDisplay.openedPid");
  const reused = beforePids.includes(openedPid);
  if (!reused) {
    if (warm.contentFrame !== undefined) fail("warmDisplay.contentFrame", "omitted when no prior process was reused", warm.contentFrame);
    return { applicable: false, reason: "opened view did not reuse a process already running before the request", surface: warm.surface, openedPid };
  }
  const firstContent = frameAt(warm.contentFrame, "warmDisplay.contentFrame", { requireProof: true });
  const measuredMs = firstContent.timeMs - requestAtMs;
  if (measuredMs < 0) fail("warmDisplay.contentFrame.timeMs", `>= requestAtMs ${requestAtMs}`, firstContent.timeMs);
  const limitMs = baselineMs + FIRST_DISPLAY_MARGIN_MS;
  assert.ok(measuredMs <= limitMs,
    `view measurement warmDisplay ${measuredMs} ms exceeds ${limitMs} ms`);
  return { applicable: true, surface: warm.surface, openedPid, measuredMs, limitMs, adjustedMs: measuredMs - baselineMs, passed: true };
}

function evaluateNewProcess(value, baselineMs) {
  const newProcess = objectAt(value, "newProcess");
  const starts = arrayAt(newProcess.processStarts, "newProcess.processStarts", { length: PROCESS_START_SAMPLES })
    .map((sample, index) => {
      const path = `newProcess.processStarts[${index}]`;
      objectAt(sample, path);
      const requestAtMs = numberAt(sample.requestAtMs, `${path}.requestAtMs`);
      const readyAtMs = numberAt(sample.readyAtMs, `${path}.readyAtMs`);
      if (readyAtMs < requestAtMs) fail(`${path}.readyAtMs`, `>= requestAtMs ${requestAtMs}`, readyAtMs);
      return { requestAtMs, readyAtMs, durationMs: readyAtMs - requestAtMs };
    });
  const processStartMedianMs = median(starts.map(({ durationMs }) => durationMs));
  const displays = arrayAt(newProcess.firstDisplays, "newProcess.firstDisplays", { length: NEW_PROCESS_RUNS })
    .map((display, index) => displayAt(display, `newProcess.firstDisplays[${index}]`));
  const adjustedDisplayMs = displays.map(({ measuredMs }) => measuredMs - processStartMedianMs);
  const limitMs = baselineMs + FIRST_DISPLAY_MARGIN_MS;
  for (const [index, adjustedMs] of adjustedDisplayMs.entries()) {
    assert.ok(adjustedMs <= limitMs,
      `view measurement newProcess.firstDisplays[${index}] adjusted duration ${adjustedMs} ms exceeds ${limitMs} ms`);
  }
  return { processStarts: starts, processStartMedianMs, firstDisplays: displays, adjustedDisplayMs, limitMs, passed: true };
}

function evaluateLayoutDisplay(value) {
  return arrayAt(value, "layoutDisplay", { minimum: 1 }).map((entry, index) => {
    const path = `layoutDisplay[${index}]`;
    objectAt(entry, path);
    const changeFrame = frameAt(entry.changeFrame, `${path}.changeFrame`);
    const contentFrame = frameAt(entry.contentFrame, `${path}.contentFrame`, { requireProof: true });
    if (entry.changeFrame.frameCount !== undefined && entry.contentFrame.frameCount !== undefined) {
      sameValue(entry.changeFrame.frameCount, entry.contentFrame.frameCount, `${path}.contentFrame.frameCount`);
    }
    const measuredMs = contentFrame.timeMs - changeFrame.timeMs;
    if (measuredMs < 0) fail(`${path}.contentFrame.timeMs`, `>= changeFrame.timeMs ${changeFrame.timeMs}`, contentFrame.timeMs);
    const width = numberAt(entry.contentFrame.width, `${path}.contentFrame.width`, { minimum: Number.MIN_VALUE });
    const height = numberAt(entry.contentFrame.height, `${path}.contentFrame.height`, { minimum: Number.MIN_VALUE });
    const requestAtMs = numberAt(entry.contentFrame.requestAtMs, `${path}.contentFrame.requestAtMs`);
    const sourceTimeMs = numberAt(entry.contentFrame.sourceTimeMs, `${path}.contentFrame.sourceTimeMs`);
    const nativePlacement = nativePlacementAt(entry.contentFrame.nativePlacement, `${path}.contentFrame.nativePlacement`);
    if (nativePlacement.phase !== "placed" || nativePlacement.timeMs <= requestAtMs) {
      fail(`${path}.contentFrame.nativePlacement`, `an applied placement after request ${requestAtMs} ms`, nativePlacement);
    }
    if (nativePlacement.timeMs > sourceTimeMs) {
      fail(`${path}.contentFrame.nativePlacement.timeMs`, `<= source frame time ${sourceTimeMs} ms`, nativePlacement.timeMs);
    }
    if (sourceTimeMs > contentFrame.timeMs) {
      fail(`${path}.contentFrame.sourceTimeMs`, `<= captured content frame time ${contentFrame.timeMs} ms`, sourceTimeMs);
    }
    const { width: viewportWidth, height: viewportHeight } = nativePlacement.webKitViewport;
    if (width !== viewportWidth || height !== viewportHeight) {
      fail(`${path}.contentFrame`, "content frame matching the projected WebKit viewport", {
        width, height, nativeFramePt: nativePlacement.framePt, webKitViewport: nativePlacement.webKitViewport,
      });
    }
    assert.ok(measuredMs <= LAYOUT_DISPLAY_LIMIT_MS,
      `view measurement ${path} measured ${measuredMs} ms, exceeding ${LAYOUT_DISPLAY_LIMIT_MS} ms`);
    return { changeFrame, contentFrame, measuredMs, passed: true };
  });
}

function nativePlacementAt(value, path) {
  objectAt(value, path);
  const surface = textAt(value.surface, `${path}.surface`);
  const phase = textAt(value.phase, `${path}.phase`);
  if (phase !== "placed" && phase !== "settled") fail(`${path}.phase`, "placed or settled", phase);
  if (value.visible !== true) fail(`${path}.visible`, "true", value.visible);
  const timeMs = numberAt(value.timeMs, `${path}.timeMs`);
  const frame = objectAt(value.framePt, `${path}.framePt`);
  const framePt = {
    x: numberAt(frame.x, `${path}.framePt.x`, { minimum: -Infinity }),
    y: numberAt(frame.y, `${path}.framePt.y`, { minimum: -Infinity }),
    width: numberAt(frame.width, `${path}.framePt.width`, { minimum: Number.MIN_VALUE }),
    height: numberAt(frame.height, `${path}.framePt.height`, { minimum: Number.MIN_VALUE }),
  };
  const projection = objectAt(value.webKitViewport, `${path}.webKitViewport`);
  const webKitViewport = {
    width: numberAt(projection.width, `${path}.webKitViewport.width`, { minimum: 1, integer: true }),
    height: numberAt(projection.height, `${path}.webKitViewport.height`, { minimum: 1, integer: true }),
  };
  if (webKitViewport.width !== Math.trunc(framePt.width)
      || webKitViewport.height !== Math.trunc(framePt.height)) {
    fail(`${path}.webKitViewport`, "the per-axis integer truncation of framePt dimensions", { framePt, webKitViewport });
  }
  const placement = objectAt(value.placement, `${path}.placement`);
  if (phase === "placed") {
    sameValue(placement.event, "host.trace.surface", `${path}.placement.event`);
    const fields = objectAt(placement.fields, `${path}.placement.fields`);
    sameValue(fields.surface, surface, `${path}.placement.fields.surface`);
    sameValue(fields.phase, "placed", `${path}.placement.fields.phase`);
    sameValue(fields.visible, true, `${path}.placement.fields.visible`);
    sameValue(fields.x, framePt.x, `${path}.placement.fields.x`);
    sameValue(fields.y, framePt.y, `${path}.placement.fields.y`);
    sameValue(fields.w, framePt.width, `${path}.placement.fields.w`);
    sameValue(fields.h, framePt.height, `${path}.placement.fields.h`);
    const monoNs = numberAt(placement.mono_ns, `${path}.placement.mono_ns`, { minimum: 1 });
    const tsUs = numberAt(placement.ts_us, `${path}.placement.ts_us`, { minimum: 1 });
    if (!Number.isInteger(monoNs) || !Number.isInteger(tsUs)) {
      fail(`${path}.placement`, "integer host ts_us and mono_ns clocks", { ts_us: tsUs, mono_ns: monoNs });
    }
    sameValue(monoNs / 1_000_000, timeMs, `${path}.placement mono_ns time`);
  } else {
    sameValue(placement.surface, surface, `${path}.placement.surface`);
    sameValue(placement.visible, true, `${path}.placement.visible`);
    sameValue(placement.timeMs, timeMs, `${path}.placement.timeMs`);
    sameValue(placement.framePt?.x, framePt.x, `${path}.placement.framePt.x`);
    sameValue(placement.framePt?.y, framePt.y, `${path}.placement.framePt.y`);
    sameValue(placement.framePt?.width, framePt.width, `${path}.placement.framePt.width`);
    sameValue(placement.framePt?.height, framePt.height, `${path}.placement.framePt.height`);
    if (typeof placement.monoNs !== "string" || !/^\d+$/u.test(placement.monoNs)) {
      fail(`${path}.placement.monoNs`, "raw monotonic clock text", placement.monoNs);
    }
    sameValue(Number(BigInt(placement.monoNs)) / 1_000_000, timeMs, `${path}.placement monoNs time`);
  }
  return { surface, phase, visible: value.visible, timeMs, framePt, webKitViewport, placement };
}

function evaluateEditorFootprint(value, requested) {
  if (!requested) {
    if (value !== undefined) fail("editorFootprint", "omitted unless the descriptor requests editor measurement", value);
    return undefined;
  }
  const editor = objectAt(value, "editorFootprint");
  const viewBytes = numberAt(editor.viewBytes, "editorFootprint.viewBytes", { integer: true });
  const hiddenDomBytes = numberAt(editor.hiddenDomBytes, "editorFootprint.hiddenDomBytes", { integer: true });
  return { viewBytes, hiddenDomBytes, sidecarRequired: viewBytes > EDITOR_SIDECAR_THRESHOLD_BYTES };
}

function evaluateDrag(value) {
  const drag = objectAt(value, "drag");
  const recordedFrameCount = numberAt(drag.recordedFrameCount, "drag.recordedFrameCount", { minimum: 1, integer: true });
  const firstGestureFrameIndex = numberAt(drag.firstGestureFrameIndex, "drag.firstGestureFrameIndex", { integer: true });
  const lastGestureFrameIndex = numberAt(drag.lastGestureFrameIndex, "drag.lastGestureFrameIndex", { integer: true });
  const gestureEndedFrameIndex = numberAt(drag.gestureEndedFrameIndex, "drag.gestureEndedFrameIndex", { integer: true });
  const gestureStartedAtMs = numberAt(drag.gestureStartedAtMs, "drag.gestureStartedAtMs");
  const gestureEndedAtMs = numberAt(drag.gestureEndedAtMs, "drag.gestureEndedAtMs");
  if (gestureStartedAtMs > gestureEndedAtMs) {
    fail("drag.gestureStartedAtMs", `<= gestureEndedAtMs ${gestureEndedAtMs}`, gestureStartedAtMs);
  }
  if (firstGestureFrameIndex > lastGestureFrameIndex || lastGestureFrameIndex !== gestureEndedFrameIndex ||
      lastGestureFrameIndex >= recordedFrameCount || gestureEndedFrameIndex >= recordedFrameCount) {
    fail("drag gesture frame range", "ordered indices within the recording", { firstGestureFrameIndex, lastGestureFrameIndex, gestureEndedFrameIndex, recordedFrameCount });
  }
  const geometryFrames = arrayAt(drag.geometryFrames, "drag.geometryFrames", { length: lastGestureFrameIndex - firstGestureFrameIndex + 1 });
  let maxGeometryErrorPt = 0;
  let previousGeometryTime = -Infinity;
  for (const [index, frame] of geometryFrames.entries()) {
    const path = `drag.geometryFrames[${index}]`;
    const identity = frameAt(frame, path, { recordedFrameCount });
    const expectedIndex = firstGestureFrameIndex + index;
    if (identity.frameIndex !== expectedIndex) fail(`${path}.frameIndex`, `one geometry row for every frame; expected frameIndex ${expectedIndex}`, identity.frameIndex);
    if (identity.timeMs <= previousGeometryTime) fail(`${path}.timeMs`, "strictly increasing geometry timestamps", identity.timeMs);
    previousGeometryTime = identity.timeMs;
    const cardRect = rectAt(frame.cardRectPt, `${path}.cardRectPt`, { allowNegative: true });
    const nativeRect = rectAt(frame.nativeRectPt, `${path}.nativeRectPt`, { allowNegative: true });
    const slotInsets = slotInsetsAt(frame.slotInsetsPt, `${path}.slotInsetsPt`);
    const expectedSlot = {
      left: cardRect.left + slotInsets.left,
      top: cardRect.top + slotInsets.top,
      right: cardRect.right - slotInsets.right,
      bottom: cardRect.bottom - slotInsets.bottom,
    };
    if (expectedSlot.right <= expectedSlot.left || expectedSlot.bottom <= expectedSlot.top) {
      fail(`${path}.slotInsetsPt`, "insets that leave a positive card slot", slotInsets);
    }
    for (const edge of ["left", "top", "right", "bottom"]) {
      maxGeometryErrorPt = Math.max(maxGeometryErrorPt, Math.abs(expectedSlot[edge] - nativeRect[edge]));
    }
  }
  assert.ok(maxGeometryErrorPt <= DRAG_GEOMETRY_LIMIT_PT,
    `view measurement drag geometry differs by ${maxGeometryErrorPt} pt, exceeding ${DRAG_GEOMETRY_LIMIT_PT} pt`);
  arrayAt(drag.layouts, "drag.layouts", { minimum: 1 });
  arrayAt(drag.ticks, "drag.ticks", { minimum: 1 });

  let previousSequence = -1;
  let previousTime = -Infinity;
  let previousFrameIndex = -1;
  const contentFrames = arrayAt(drag.contentFrames, "drag.contentFrames", { minimum: 1 }).map((frame, index) => {
    const path = `drag.contentFrames[${index}]`;
    objectAt(frame, path);
    const sourceSequence = numberAt(frame.sourceSequence, `${path}.sourceSequence`, { integer: true });
    if (sourceSequence <= previousSequence) {
      fail(`${path}.sourceSequence`, `greater than prior source sequence ${previousSequence}`, sourceSequence);
    }
    previousSequence = sourceSequence;
    const timeMs = numberAt(frame.timeMs, `${path}.timeMs`);
    if (timeMs <= previousTime) fail(`${path}.timeMs`, "strictly increasing source timestamps", timeMs);
    previousTime = timeMs;
    let frameIndex = null;
    if (frame.frameIndex !== null && frame.frameIndex !== undefined) {
      frameIndex = numberAt(frame.frameIndex, `${path}.frameIndex`, { integer: true });
      if (frameIndex >= recordedFrameCount) fail(`${path}.frameIndex`, `less than recordedFrameCount ${recordedFrameCount}`, frameIndex);
      if (frameIndex < previousFrameIndex) fail(`${path}.frameIndex`, `>= prior mapped capture index ${previousFrameIndex}`, frameIndex);
      previousFrameIndex = frameIndex;
    }
    const width = numberAt(frame.width, `${path}.width`, { minimum: Number.MIN_VALUE });
    const height = numberAt(frame.height, `${path}.height`, { minimum: Number.MIN_VALUE });
    const nativePlacement = nativePlacementAt(frame.nativePlacement, `${path}.nativePlacement`);
    if (nativePlacement.timeMs > timeMs) {
      fail(`${path}.nativePlacement.timeMs`, `<= source frame time ${timeMs} ms`, nativePlacement.timeMs);
    }
    return {
      sourceSequence,
      frameIndex,
      timeMs,
      width,
      height,
      nativePlacement,
    };
  });
  const inGestureFrames = contentFrames.filter(({ timeMs }) =>
    timeMs >= gestureStartedAtMs && timeMs <= gestureEndedAtMs);
  if (inGestureFrames.length < 2) fail("drag.contentFrames", "at least two content frames during the gesture", inGestureFrames.length);
  for (const [index, frame] of inGestureFrames.entries()) {
    if (frame.frameIndex === null) {
      fail(`drag.contentFrames source sequence ${frame.sourceSequence}`, "a recorded capture frame at or after its source timestamp", null);
    }
    if (frame.frameIndex < firstGestureFrameIndex || frame.frameIndex >= recordedFrameCount) {
      fail(`drag.contentFrames source sequence ${frame.sourceSequence}`, "a capture frame in the recorded gesture interval or its tail", frame.frameIndex);
    }
  }
  const intervalsMs = inGestureFrames.slice(1).map((frame, index) => frame.timeMs - inGestureFrames[index].timeMs);
  const maxContentFrameIntervalMs = Math.max(...intervalsMs);
  assert.ok(maxContentFrameIntervalMs <= DRAG_CONTENT_INTERVAL_LIMIT_MS,
    `view measurement drag in-gesture content-frame interval ${maxContentFrameIntervalMs} ms exceeds ${DRAG_CONTENT_INTERVAL_LIMIT_MS} ms`);

  const atEnd = inGestureFrames.at(-1);
  if (!atEnd) fail("drag.contentFrames", "a content frame at or before gesture end", contentFrames.map(({ frameIndex }) => frameIndex));
  const mismatchedAtEnd = atEnd.width !== atEnd.nativePlacement.webKitViewport.width
    || atEnd.height !== atEnd.nativePlacement.webKitViewport.height;
  let convergedFrame = 0;
  let convergenceMs = 0;
  if (mismatchedAtEnd) {
    const postGestureFrames = contentFrames.filter(({ timeMs }) => timeMs > gestureEndedAtMs);
    const converged = postGestureFrames.find(({ frameIndex, width, height, nativePlacement }) =>
      frameIndex !== null && frameIndex > gestureEndedFrameIndex
      && width === nativePlacement.webKitViewport.width && height === nativePlacement.webKitViewport.height);
    if (!converged) fail("drag.contentFrames", "content size convergence after gesture end", postGestureFrames);
    convergedFrame = converged.frameIndex - gestureEndedFrameIndex;
    convergenceMs = converged.timeMs - gestureEndedAtMs;
    if (convergedFrame > DRAG_SETTLE_FRAME_LIMIT) {
      fail("drag.contentFrames", `convergence within ${DRAG_SETTLE_FRAME_LIMIT} post-gesture frames`, convergedFrame);
    }
    if (convergenceMs < 0 || convergenceMs > DRAG_CONTENT_INTERVAL_LIMIT_MS) {
      fail("drag.contentFrames", `convergence within ${DRAG_CONTENT_INTERVAL_LIMIT_MS} ms after gesture end`, convergenceMs);
    }
  }
  return {
    maxGeometryErrorPt,
    geometryLimitPt: DRAG_GEOMETRY_LIMIT_PT,
    maxContentFrameIntervalMs,
    contentFrameIntervalLimitMs: DRAG_CONTENT_INTERVAL_LIMIT_MS,
    convergedFrame,
    convergenceMs,
    convergenceFrameLimit: DRAG_SETTLE_FRAME_LIMIT,
    passed: true,
  };
}

/**
 * Checks collected plugin-view measurements against plugin-processes.md. Request and frame timestamps share the
 * recording display clock; collectors convert source event mono_ns values to milliseconds and retain the original
 * event ts_us and mono_ns values with their measurements.
 */
export function assertViewMeasurements(measurements, { plugin, host, baselineMs, measureEditorFootprint = false } = {}) {
  objectAt(measurements, "measurements");
  textAt(plugin, "descriptor.plugin");
  textAt(host, "descriptor.host");
  numberAt(baselineMs, "descriptor.baselineMs");
  sameValue(plugin, textAt(measurements.plugin, "measurements.plugin"), "measurements.plugin");
  sameValue(host, textAt(measurements.host, "measurements.host"), "measurements.host");

  const total = evaluateTotal(measurements.total);
  const reclaim = evaluateReclaim(measurements.reclaim);
  const warmDisplay = evaluateWarmDisplay(measurements.warmDisplay, baselineMs);
  const newProcess = evaluateNewProcess(measurements.newProcess, baselineMs);
  const layoutDisplay = evaluateLayoutDisplay(measurements.layoutDisplay);
  const editorFootprint = evaluateEditorFootprint(measurements.editorFootprint, measureEditorFootprint);
  const drag = evaluateDrag(measurements.drag);
  return {
    measurements,
    evaluation: {
      plugin,
      host,
      baselineMs,
      total,
      reclaim,
      warmDisplay,
      newProcess,
      layoutDisplay,
      ...(editorFootprint === undefined ? {} : { editorFootprint }),
      drag,
    },
  };
}

function errorDocument(error) {
  if (error instanceof Error) {
    return JSON.stringify({ name: error.name, message: error.message, stack: error.stack ?? null }, null, 2) + "\n";
  }
  return JSON.stringify({ name: typeof error, message: String(error) }, null, 2) + "\n";
}

/** Collects one plugin's window measurements and evaluates them with the current host's fixed baseline. */
export async function runViewMeasurements(t, s, descriptor) {
  objectAt(descriptor, "descriptor");
  const plugin = textAt(descriptor.plugin, "descriptor.plugin");
  const baselines = objectAt(descriptor.baselinesMs, "descriptor.baselinesMs");
  const host = textAt(s?.app?.name, "session.app.name");
  const baselineMs = numberAt(baselines[host], `descriptor.baselinesMs.${host}`);
  if (typeof descriptor.collect !== "function") fail("descriptor.collect", "a measurement collection function", descriptor.collect);
  if (descriptor.measureEditorFootprint !== undefined && typeof descriptor.measureEditorFootprint !== "boolean") {
    fail("descriptor.measureEditorFootprint", "a boolean", descriptor.measureEditorFootprint);
  }
  const configDir = textAt(s?.app?.configDir, "session.app.configDir");
  if (!isAbsolute(configDir)) fail("session.app.configDir", "an absolute configuration directory", configDir);
  if (typeof t?.diagnostic !== "function") fail("testContext.diagnostic", "a diagnostic reporting function", t?.diagnostic);
  const logsDirectory = join(configDir, "logs");
  await mkdir(logsDirectory, { recursive: true });
  const artifactDirectory = await mkdtemp(join(logsDirectory, "view-measurements-"));
  t.diagnostic(`view measurement artifacts: ${artifactDirectory}`);
  try {
    const measurements = await descriptor.collect(t, s);
    const rawDocument = JSON.stringify(measurements, null, 2);
    if (typeof rawDocument !== "string") fail("measurements", "JSON-serializable raw measurements", measurements);
    await writeFile(join(artifactDirectory, "measurements.json"), `${rawDocument}\n`, "utf8");
    const report = assertViewMeasurements(measurements, {
      plugin, host, baselineMs, measureEditorFootprint: descriptor.measureEditorFootprint,
    });
    await writeFile(join(artifactDirectory, "evaluation.json"), `${JSON.stringify(report.evaluation, null, 2)}\n`, "utf8");
    return report;
  } catch (error) {
    try {
      await writeFile(join(artifactDirectory, "error.json"), errorDocument(error), "utf8");
    } catch (artifactError) {
      throw new AggregateError([error, artifactError],
        `view measurement failed and its error artifact could not be written in ${artifactDirectory}`);
    }
    throw error;
  }
}
