import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { joinedFailure } from "./failure.mjs";

const TOTAL_MARGIN_BYTES = 10_000_000;
const RECLAIM_FRACTION = 0.9;
const RECLAIM_LIMIT_MS = 10_000;
export const FIRST_DISPLAY_MARGIN_MS = 300;
const PROCESS_START_SAMPLES = 5;
const NEW_PROCESS_RUNS = 3;
const EDITOR_SIDECAR_THRESHOLD_BYTES = 50_000_000;

export const normalizeViewText = text => text.normalize("NFC").replace(/\s/gu, "");

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

/**
 * The DOM mount baseline of a plugin view on a host, the base of the first-display limits (iii) and (iii-b) of
 * docs/spec/plugin-processes.md#pass-values. `recordedMs` is the median that the surface mount measurement recorded for
 * the plugin on the Wails and on the Tauri host, `{ wailsv3, tauriv2 }`, or null for a plugin without a recorded value.
 * The wailsv3 and the tauriv2 host take their recorded value, and the mygo host takes the lower of the two, because the
 * surface mount was removed before the mygo host existed and the lower value keeps its limit at least as strict as the
 * limit of either recorded host. A plugin without a recorded value has the baseline 0 on every host, so it is judged
 * against the margin alone.
 */
export function domMountBaselineMs(host, recordedMs) {
  const reject = (path, expected, found) => {
    throw new Error(`DOM mount baseline ${path}: expected ${expected}, found ${JSON.stringify(found)}`);
  };
  if (!["wailsv3", "tauriv2", "mygo"].includes(host)) reject("host", "wailsv3, tauriv2 or mygo", host);
  if (recordedMs === null) return 0;
  if (typeof recordedMs !== "object" || Array.isArray(recordedMs)) reject("recordedMs", "an object or null", recordedMs);
  const keys = Object.keys(recordedMs);
  if (keys.some((key) => key !== "wailsv3" && key !== "tauriv2")) reject("recordedMs", "the keys wailsv3 and tauriv2", keys);
  for (const key of ["wailsv3", "tauriv2"]) {
    if (!Number.isFinite(recordedMs[key]) || recordedMs[key] < 0) reject(`recordedMs.${key}`, "a finite number >= 0", recordedMs[key]);
  }
  return host === "mygo" ? Math.min(recordedMs.wailsv3, recordedMs.tauriv2) : recordedMs[host];
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
    fail(`${path}.frameCount`, "the recorded frame count of the content frame", value.frameCount);
  }
  const timeMs = numberAt(value.timeMs, `${path}.timeMs`);
  if (requireProof) contentProofAt(value.proof, `${path}.proof`);
  return { frameIndex, timeMs };
}

function contentProofAt(value, path) {
  objectAt(value, path);
  if (value.method !== "value") fail(`${path}.method`, JSON.stringify("value"), value.method);
  const expected = textAt(value.expected, `${path}.expected`);
  if (normalizeViewText(expected).length === 0) fail(`${path}.expected`, "text with a non-whitespace character", expected);
  const actual = textAt(value.actual, `${path}.actual`);
  assert.ok(normalizeViewText(actual).includes(normalizeViewText(expected)),
    `view measurement ${path}.actual does not contain the expected text ${JSON.stringify(expected)}`);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
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

export function evaluateReclaim(value) {
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

/**
 * Checks collected plugin-view measurements against plugin-processes.md. Drag input, successful display, source-frame
 * intervals and capture times use the host monotonic clock; native placement readbacks remain raw event evidence and
 * are not assigned to individual source frames.
 */
export function assertViewMeasurements(measurements, { plugin, host, baselineMs, measureEditorFootprint = false } = {}) {
  objectAt(measurements, "measurements");
  textAt(plugin, "descriptor.plugin");
  textAt(host, "descriptor.host");
  numberAt(baselineMs, "descriptor.baselineMs");
  sameValue(plugin, textAt(measurements.plugin, "measurements.plugin"), "measurements.plugin");
  sameValue(host, textAt(measurements.host, "measurements.host"), "measurements.host");

  const evaluations = {};
  const failures = [];
  const evaluate = (category, operation) => {
    try {
      evaluations[category] = operation();
    } catch (error) {
      failures.push({ category, error });
    }
  };
  evaluate("total", () => evaluateTotal(measurements.total));
  evaluate("reclaim", () => evaluateReclaim(measurements.reclaim));
  evaluate("warmDisplay", () => evaluateWarmDisplay(measurements.warmDisplay, baselineMs));
  evaluate("newProcess", () => evaluateNewProcess(measurements.newProcess, baselineMs));
  evaluate("editorFootprint", () => evaluateEditorFootprint(measurements.editorFootprint, measureEditorFootprint));
  if (failures.length === 1) throw failures[0].error;
  if (failures.length > 1) {
    const errors = failures.map(({ category, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      return new Error(`${category}: ${message}`, { cause: error });
    });
    throw joinedFailure("view measurement criteria failed", errors);
  }

  const { total, reclaim, warmDisplay, newProcess, editorFootprint } = evaluations;
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
      ...(editorFootprint === undefined ? {} : { editorFootprint }),
    },
  };
}

function errorDocument(error) {
  const seen = new WeakSet();
  const record = (value) => {
    if (!(value instanceof Error)) return { name: typeof value, message: String(value) };
    if (seen.has(value)) return { name: value.name, message: value.message, circular: true };
    seen.add(value);
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
      ...(value.criteria === undefined ? {} : { criteria: value.criteria }),
      ...(value instanceof AggregateError ? { errors: [...value.errors].map(record) } : {}),
      ...(value.cause === undefined ? {} : { cause: record(value.cause) }),
    };
  };
  return `${JSON.stringify(record(error), null, 2)}\n`;
}

/**
 * Collects one plugin's window measurements and evaluates them with the current host's DOM mount baseline, which
 * domMountBaselineMs gives for the plugin's recorded baselines `descriptor.baselinesMs`.
 */
export async function runViewMeasurements(t, s, descriptor) {
  objectAt(descriptor, "descriptor");
  const plugin = textAt(descriptor.plugin, "descriptor.plugin");
  const host = textAt(s?.app?.name, "session.app.name");
  const baselineMs = domMountBaselineMs(host, descriptor.baselinesMs);
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
    // A skipped frame takes a different time at each refresh rate, so a result has its meaning only with this rate.
    const { refreshRate: displayRefreshRate } = await s.get("host.window");
    if (!Number.isInteger(displayRefreshRate) || displayRefreshRate <= 0) {
      fail("host.window.refreshRate", "a positive integer", displayRefreshRate);
    }
    t.diagnostic(`view measurement display refresh rate: ${displayRefreshRate} Hz`);
    const measurements = await descriptor.collect(t, s);
    const rawDocument = JSON.stringify({ ...measurements, displayRefreshRate }, null, 2);
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
      throw joinedFailure(`view measurement failed and its error artifact could not be written in ${artifactDirectory}`, [error, artifactError]);
    }
    throw error;
  }
}
