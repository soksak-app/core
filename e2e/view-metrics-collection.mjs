import assert from "node:assert/strict";

import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { firstContentFrame } from "./view-first-content.mjs";
import { allViewRootProcessPids, measureProcessGroup, physicalFootprintBytes, processGroupReclaimEvidence,
  viewProcessGroup, viewProcessPids, viewProcessSurfaces, viewRootProcessPids } from "./view-process-footprint.mjs";

const PROCESS_REQUEST = "host.trace.view.process-request";
const PROCESS_READY = "host.trace.view.process-ready";

/** Pairs each view's host request with its first ready event, keeping both source clocks. */
export function processStartSamples(events, surfaces, plugin) {
  assert.ok(Array.isArray(events), "view process events must be an array");
  assert.ok(Array.isArray(surfaces) && surfaces.length > 0, "view process surfaces must be a nonempty array");
  assert.ok(typeof plugin === "string" && plugin.length > 0, "view process plugin must be nonempty text");
  assert.equal(new Set(surfaces).size, surfaces.length, "view process surfaces must be unique");
  const selected = new Set(surfaces);
  const pairs = new Map(surfaces.map((surface) => [surface, { requests: [], ready: [] }]));
  for (const event of events) {
    if (event?.event !== PROCESS_REQUEST && event?.event !== PROCESS_READY) continue;
    if (event.fields?.plugin !== plugin || !selected.has(event.fields.surface)) continue;
    assert.ok(Number.isSafeInteger(event.ts_us) && event.ts_us >= 0,
      `${event.event} for ${event.fields.surface} has invalid ts_us ${JSON.stringify(event.ts_us)}`);
    assert.ok(Number.isInteger(event.mono_ns) && event.mono_ns > 0,
      `${event.event} for ${event.fields.surface} has no canonical monotonic mono_ns timestamp`);
    pairs.get(event.fields.surface)[event.event === PROCESS_REQUEST ? "requests" : "ready"].push({
      ts_us: event.ts_us,
      mono_ns: event.mono_ns,
      raw: event,
    });
  }
  return surfaces.map((surface) => {
    const { requests, ready } = pairs.get(surface);
    assert.ok(requests.length > 0, `${surface} has no process-request event`);
    assert.equal(requests.length, 1, `${surface} has duplicate process-request events`);
    assert.ok(ready.length > 0, `${surface} has no process-ready event`);
    assert.equal(ready.length, 1, `${surface} has duplicate process-ready events`);
    assert.ok(ready[0].mono_ns > requests[0].mono_ns,
      `${surface} process-ready ${ready[0].mono_ns} precedes process-request ${requests[0].mono_ns}`);
    return {
      requestAtMs: Number(requests[0].mono_ns) / 1_000_000,
      readyAtMs: Number(ready[0].mono_ns) / 1_000_000,
      requestTsUs: requests[0].ts_us,
      readyTsUs: ready[0].ts_us,
      requestMonoNs: requests[0].mono_ns,
      readyMonoNs: ready[0].mono_ns,
      requestEvent: requests[0].raw,
      readyEvent: ready[0].raw,
    };
  });
}

/** Correlates a plugin document's ResizeObserver→rAF rows with both clocks of the host event log. */
export function viewContentFrameEvents(events, plugin, surface) {
  assert.ok(Array.isArray(events), "view content-frame events must be an array");
  assert.ok(typeof plugin === "string" && plugin.length > 0, "view content-frame plugin must be nonempty text");
  assert.ok(typeof surface === "string" && surface.length > 0, "view content-frame surface must be nonempty text");
  const name = `plugin.${plugin}.view.content_frame`;
  const selected = events.filter((event) => event?.event === name && (event.surface ?? event.fields?.surface) === surface);
  let priorSequence = -1;
  return selected.map((event) => {
    const { sequence, documentTimeOriginMs, resizeAtMs, frameTimeMs, width, height } = event.fields ?? {};
    assert.ok(Number.isSafeInteger(sequence) && sequence >= 0 && sequence > priorSequence,
      `${name} sequence must increase for ${surface}`);
    priorSequence = sequence;
    assert.ok(Number.isSafeInteger(event.ts_us) && event.ts_us > 0, `${name} has invalid host ts_us`);
    assert.ok(Number.isInteger(event.mono_ns) && event.mono_ns > 0, `${name} has invalid host mono_ns`);
    assert.ok(Number.isFinite(documentTimeOriginMs) && documentTimeOriginMs > 0,
      `${name} has invalid documentTimeOriginMs`);
    assert.ok(Number.isFinite(resizeAtMs) && resizeAtMs >= 0, `${name} has invalid resizeAtMs`);
    assert.ok(Number.isFinite(frameTimeMs) && frameTimeMs >= resizeAtMs,
      `${name} frameTimeMs must be at or after resizeAtMs`);
    assert.ok(Number.isFinite(width) && width > 0, `${name} has invalid width`);
    assert.ok(Number.isFinite(height) && height > 0, `${name} has invalid height`);
    const sourceTimeMs = documentTimeOriginMs + frameTimeMs;
    const hostWallMs = event.ts_us / 1000;
    const wallCorrelationMs = hostWallMs - sourceTimeMs;
    const hostArrivalTimeMs = event.mono_ns / 1_000_000;
    const mappedTimeMs = hostArrivalTimeMs - wallCorrelationMs;
    return {
      sequence, width, height, resizeAtMs, frameTimeMs,
      sourceTimeMs,
      timeMs: mappedTimeMs,
      hostArrivalTimeMs,
      wallCorrelationMs,
      source: { documentTimeOriginMs, ts_us: event.ts_us, mono_ns: event.mono_ns },
    };
  });
}

/** Maps every source ResizeObserver→rAF row to the first later capture frame without coalescing source events. */
export function mapViewContentFramesToCapture(contentFrames, captured) {
  assert.ok(Array.isArray(contentFrames), "view content frames must be an array");
  assert.ok(Array.isArray(captured) && captured.length > 0, "view capture frames must be a nonempty array");
  let priorSequence = -1;
  let priorSourceTime = -Infinity;
  let priorCaptureTime = -Infinity;
  for (const [index, frame] of captured.entries()) {
    assert.ok(Number.isFinite(frame?.time) && frame.time >= 0,
      `capture frame ${index} has an invalid display time`);
    assert.ok(frame.time > priorCaptureTime, `capture frame ${index} time does not increase`);
    priorCaptureTime = frame.time;
  }
  return contentFrames.map((source, index) => {
    assert.ok(Number.isSafeInteger(source?.sequence) && source.sequence >= 0 && source.sequence > priorSequence,
      `source content frame ${index} sequence must be nonnegative and strictly increasing`);
    assert.ok(Number.isFinite(source.timeMs) && source.timeMs >= 0 && source.timeMs > priorSourceTime,
      `source content frame ${index} time must be finite and strictly increasing`);
    priorSequence = source.sequence;
    priorSourceTime = source.timeMs;
    const frameIndex = source.timeMs < captured[0].time || source.timeMs > captured.at(-1).time
      ? -1 : captured.findIndex((frame) => frame.time >= source.timeMs);
    return { ...source, sourceSequence: source.sequence, frameIndex: frameIndex < 0 ? null : frameIndex };
  });
}

/** Keeps capture-backed events and rejects any source event during the gesture that recording missed. */
export function requireViewContentFrameCoverage(mappedFrames, { gestureStartedAtMs, gestureEndedAtMs }) {
  assert.ok(Number.isFinite(gestureStartedAtMs) && Number.isFinite(gestureEndedAtMs)
    && gestureStartedAtMs <= gestureEndedAtMs, "view gesture source interval is invalid");
  assert.ok(Array.isArray(mappedFrames), "mapped view content frames must be an array");
  return mappedFrames.filter((frame) => {
    if (frame.frameIndex !== null) return true;
    if (frame.timeMs >= gestureStartedAtMs && frame.timeMs <= gestureEndedAtMs) {
      assert.fail(`source content frame ${frame.sourceSequence} inside the gesture has no capture frame`);
    }
    return false;
  });
}

/** Runs a gesture or layout operation between explicit source-frame observer start and stop callbacks. */
export async function withViewContentTrace(t, s, descriptor, surface, action) {
  assert.ok(typeof descriptor?.plugin === "string" && descriptor.plugin.length > 0,
    "content trace descriptor must name its plugin");
  assert.equal(typeof descriptor.startContentTrace, "function", "content trace start callback is required");
  assert.equal(typeof descriptor.stopContentTrace, "function", "content trace stop callback is required");
  assert.equal(typeof action, "function", "content trace action is required");
  const offsets = currentEventOffsets(s.app.configDir);
  await descriptor.startContentTrace(s, surface);
  let actionResult;
  let actionError;
  try {
    actionResult = await action();
  } catch (error) {
    actionError = error;
  }
  let stopResult;
  let stopError;
  try {
    stopResult = await descriptor.stopContentTrace(s, surface);
  } catch (error) {
    stopError = error;
    t.diagnostic(`content-frame observer stop failed for ${surface}: ${error.stack ?? error}`);
  }
  let events;
  let eventError;
  try {
    await s.flushLog();
    events = readEvents(s.app.configDir, offsets).events;
  } catch (error) {
    eventError = error;
    t.diagnostic(`content-frame events could not be read for ${surface}: ${error.stack ?? error}`);
  }
  if (actionError && (stopError || eventError)) {
    throw new AggregateError([actionError, ...[stopError, eventError].filter(Boolean)],
      `content trace action and evidence finalization failed for ${surface}`);
  }
  if (actionError) throw actionError;
  if (stopError && eventError) throw new AggregateError([stopError, eventError], `content trace finalization failed for ${surface}`);
  if (stopError) throw stopError;
  if (eventError) throw eventError;
  const contentFrames = viewContentFrameEvents(events, descriptor.plugin, surface);
  return { action: actionResult, stop: stopResult, events, contentFrames };
}

/** Reads the shared monotonic host clock in the same domain as recorded frame display times. */
export async function monotonicTimeMs(s) {
  const value = await s.request("diagnostics.clock", {});
  assert.ok(typeof value?.mono_ns === "string" && /^[1-9]\d*$/u.test(value.mono_ns),
    `diagnostics.clock returned an invalid mono_ns ${JSON.stringify(value?.mono_ns)}`);
  return { monoNs: value.mono_ns, timeMs: Number(BigInt(value.mono_ns)) / 1_000_000 };
}

/** Opens a view under a live recording and proves its first visible content from a decoded capture frame. */
export async function openRecordedView(t, s, { card, plugin, params, readiness, expectedContent, language,
  recognizeFrame } = {}) {
  assert.ok(typeof card === "string" && card.length > 0, "view card must be nonempty text");
  assert.ok(typeof plugin === "string" && plugin.length > 0, "view plugin must be nonempty text");
  assert.equal(typeof readiness, "function", "view readiness callback is required");
  assert.ok(typeof expectedContent === "string" && expectedContent.length > 0, "expected view content is required");
  assert.ok(typeof language === "string" && language.length > 0, "view content language is required");
  assert.ok(recognizeFrame === undefined || typeof recognizeFrame === "function", "view frame recognizer must be a function");

  const offsets = currentEventOffsets(s.app.configDir);
  const recording = await s.record();
  let stopped = false;
  let capture;
  try {
    const requestClock = await monotonicTimeMs(s);
    const { tab } = await s.run("core.card.add-tab", { card, plugin, params });
    s.cleanup(async () => {
      const surfaces = await s.get("core.surfaces");
      if (!surfaces.some((item) => item.surface === tab)) return;
      const result = await s.run("core.tab.close", { tab });
      assert.equal(result?.closed, true, `view ${tab} did not close during cleanup`);
      await s.until("core.surfaces", (items) => !items.some((item) => item.surface === tab),
        `view ${tab} remained registered during cleanup`);
    });
    const readinessEvidence = await readiness(s, tab);
    const { displayed } = await s.presented();
    capture = await recording.stop({ after: displayed });
    stopped = true;
    assert.equal(capture.limited, false, `${plugin} first-content recording reached its bounded frame limit`);
    const paths = frames(capture.frames);
    assert.equal(paths.length, capture.count, `${plugin} first-content recording omitted captured frames`);
    assert.ok(paths.length > 0, `${plugin} first-content recording contains no frames`);
    const decoded = paths.map(readFrame);
    const host = await s.get("host.window");
    const row = host.documents.find((document) => document.surface === tab && document.document === "");
    assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
      `${plugin} view ${tab} has no visible native view frame`);
    const result = await firstContentFrame({ captured: decoded,
      rect: { x: row.frame.x, y: row.frame.y, w: row.frame.width, h: row.frame.height },
      expected: expectedContent, language, directory: capture.frames, recognizeFrame });
    const pids = viewRootProcessPids(host, [tab]);
    assert.equal(pids.length, 1, `${plugin} view ${tab} does not have one process identity`);
    const processGroupPids = viewProcessPids(host, [tab]);
    const events = readEvents(s.app.configDir, offsets).events;
    const starts = processStartSamples(events, [tab], plugin);
    return {
      surface: tab,
      requestAtMs: starts[0].requestAtMs,
      processStart: starts[0],
      requestClock,
      readinessEvidence,
      openedPid: pids[0],
      processGroupPids,
      contentFrame: result,
      recording: { directory: capture.frames, frameCount: paths.length, files: paths },
      events,
    };
  } catch (error) {
    if (!stopped) {
      try {
        capture = await recording.stop({ after: 0 });
        stopped = true;
      } catch (stopError) {
        t.diagnostic(`view recording stop failed after collector error: ${stopError.stack ?? stopError}`);
      }
    }
    if (capture?.frames) {
      t.diagnostic(`failed view recording retained at ${capture.frames}`);
      t.diagnostic(`failed view recording result: ${JSON.stringify({ count: capture.count, limited: capture.limited })}`);
    }
    throw error;
  }
}

/** Measures the deduplicated physical footprint group of the requested view surfaces. */
export async function viewFootprints(host, surfaces, measureFootprint) {
  return measureProcessGroup(viewProcessPids(host, surfaces), measureFootprint);
}

/** Opens five traced view lifecycles, measures one and three views, and records a conditional warm reuse. */
export async function collectViewStartAndMemory(t, s, descriptor, { viewCount = 3, processStartCount = 5 } = {}) {
  assert.ok(Number.isSafeInteger(viewCount) && viewCount >= 2, "view count must be at least two");
  assert.equal(processStartCount, 5, "the view-process contract requires exactly five start samples");
  const grid = await s.get("core.grid");
  const card = grid.cards.find((item) => item.active);
  assert.ok(card?.id, "the view check has no active card for its lifecycle samples");

  const opened = [];
  const events = [];
  const open = async () => {
    const value = await openRecordedView(t, s, { card: card.id, ...descriptor });
    opened.push(value);
    events.push(...value.events);
    return value;
  };
  const first = await open();
  const oneViewProcesses = await viewFootprints(await s.get("host.window"), [first.surface]);
  while (opened.length < Math.max(viewCount, processStartCount)) await open();
  const measuredViews = opened.slice(0, viewCount);
  const allViewProcesses = await viewFootprints(await s.get("host.window"), measuredViews.map(({ surface }) => surface));
  const starts = processStartSamples(events, opened.slice(0, processStartCount).map(({ surface }) => surface), descriptor.plugin);
  const startBySurface = new Map(opened.slice(0, processStartCount).map(({ surface }, index) => [surface, starts[index]]));
  const firstDisplays = opened.slice(0, 3).map(({ surface, contentFrame }) => ({
    requestAtMs: startBySurface.get(surface).requestAtMs,
    requestEvent: startBySurface.get(surface).requestEvent,
    contentFrame,
  }));

  const beforePids = allViewRootProcessPids(await s.get("host.window"));
  const beforePidsAt = await monotonicTimeMs(s);
  const warm = await open();
  const warmDisplay = {
    surface: warm.surface,
    beforePidsAtMs: beforePidsAt.timeMs,
    beforePids,
    requestAtMs: warm.requestAtMs,
    openedPid: warm.openedPid,
    ...(beforePids.includes(warm.openedPid) ? { contentFrame: warm.contentFrame } : {}),
    requestClock: beforePidsAt,
  };
  return {
    opened,
    events,
    recordings: opened.map(({ recording }) => recording),
    total: { viewCount, oneViewProcesses, allViewProcesses },
    processStarts: starts,
    firstDisplays,
    warmDisplay,
    card: card.id,
  };
}

/** Runs the three initial-only process-group reclamation samples for opened view surfaces. */
export async function collectViewReclaimMeasurements(t, s, descriptor, views, evidence = { events: [], recordings: [] }) {
  assert.ok(Array.isArray(views) && views.length > 0, "reclaim requires opened view evidence");
  const reclaim = [];
  const closeInitial = async (views) => {
    const host = await s.get("host.window");
    const selectedPids = views.flatMap(({ processGroupPids }) => processGroupPids);
    const surfaces = viewProcessSurfaces(host, [...new Set(selectedPids)].sort((a, b) => a - b));
    assert.deepEqual([...surfaces].sort(), [...views.map(({ surface }) => surface)].sort(),
      "reclaim view set omitted a surface sharing its selected browser process group");
    const group = viewProcessGroup(host, views.map(({ surface }) => surface));
    const beforeProcesses = await measureProcessGroup(group.pids);
    const closedViews = [];
    for (const { surface, readinessEvidence } of views) {
      assert.equal(readinessEvidence?.historyEntries, 1,
        `view ${surface} did not begin with only its initial history entry`);
      assert.equal(typeof descriptor.readDocument, "function", "view history reader callback is required for reclaim");
      const document = await descriptor.readDocument(s, surface);
      assert.equal(document?.historyEntries, 1, `view ${surface} root history no longer contains only its initial document`);
      assert.ok(Number.isInteger(document?.regionHistoryEntries) && document.regionHistoryEntries >= 0,
        `view ${surface} has invalid content-region history evidence`);
      const attached = host.documents.filter((row) => row.surface === surface && row.document !== "");
      assert.equal(attached.length, document.regionHistoryEntries,
        `view ${surface} has ${attached.length} attached documents but reports ${document.regionHistoryEntries} region history entries`);
      assert.ok(attached.length <= 1,
        `view ${surface} has ${attached.length} document histories but the reader exposes one region history count`);
      closedViews.push({ surface, rootHistoryEntries: document.historyEntries,
        documents: attached.map((row) => ({ document: row.document, historyEntries: document.regionHistoryEntries })) });
    }
    return closeViewGroup(t, s, { surfaces, beforeProcesses, closedViews });
  };
  reclaim.push(await closeInitial(views));
  for (let index = 1; index < 3; index++) {
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.active);
    assert.ok(card?.id, "reclaim run has no active card");
    const view = await openRecordedView(t, s, { card: card.id, ...descriptor });
    evidence.events.push(...view.events);
    evidence.recordings.push(view.recording);
    const sample = await closeInitial([view]);
    reclaim.push(sample);
  }
  return reclaim;
}

/** Collects the plugin-independent process, first-pixel, warm-reuse and initial-only reclaim measurements. */
export async function collectViewLifecycleMeasurements(t, s, descriptor) {
  const start = await collectViewStartAndMemory(t, s, descriptor);
  const reclaim = await collectViewReclaimMeasurements(t, s, descriptor, start.opened);
  return {
    plugin: descriptor.plugin,
    host: s.app.name,
    total: start.total,
    reclaim,
    warmDisplay: start.warmDisplay,
    newProcess: { processStarts: start.processStarts, firstDisplays: start.firstDisplays },
    _evidence: { events: start.events, recordings: start.recordings },
  };
}

/** Closes every view in a shared process group and preserves live/dead PID rows. */
export async function closeViewGroup(t, s, { surfaces, beforeProcesses, closedViews }) {
  assert.ok(Array.isArray(surfaces) && surfaces.length > 0, "view close requires nonempty surfaces");
  assert.ok(Array.isArray(beforeProcesses) && beforeProcesses.length > 0, "view close requires the complete pre-close process group");
  assert.ok(Array.isArray(closedViews) && closedViews.length === surfaces.length,
    "view close requires observed initial-only history evidence for every surface");
  const host = await s.get("host.window");
  const group = viewProcessGroup(host, surfaces);
  const groupSurfaces = viewProcessSurfaces(host, beforeProcesses.map(({ pid }) => pid));
  assert.deepEqual([...surfaces].sort(), groupSurfaces,
    "view reclaim must close every active surface that shares the measured process group");
  assert.deepEqual(group.pids, beforeProcesses.map(({ pid }) => pid).sort((a, b) => a - b),
    "view reclaim footprint rows do not cover the complete root and child process group");
  for (const view of closedViews) {
    const attached = group.documents.filter((row) => row.surface === view.surface && row.document !== "")
      .map((row) => row.document).sort();
    assert.deepEqual(view.documents.map((row) => row.document).sort(), attached,
      `view ${view.surface} history evidence omits or adds a child document`);
  }
  const began = await monotonicTimeMs(s);
  for (const surface of surfaces) {
    const result = await s.run("core.tab.close", { tab: surface });
    assert.equal(result?.closed, true, `view ${surface} did not close`);
    await s.until("core.surfaces", (items) => !items.some((item) => item.surface === surface),
      `view ${surface} remained registered after close`);
  }
  const afterProcesses = await Promise.all(beforeProcesses.map(async ({ pid }) => {
    try {
      await s.request("diagnostics.process.exit", { pid });
      return { pid, footprintBytes: 0 };
    } catch (error) {
      const expectedTimeout = new RegExp(`^process ${pid} did not exit within 10s$`).test(error.message);
      if (!expectedTimeout) throw error;
      t.diagnostic(`view process ${pid} remained alive after the 10 second exit wait: ${error.message}`);
      return { pid, footprintBytes: physicalFootprintBytes(pid) };
    }
  }));
  const ended = await monotonicTimeMs(s);
  const elapsedMs = ended.timeMs - began.timeMs;
  return processGroupReclaimEvidence({ beforeProcesses, afterProcesses, elapsedMs, closedViews,
    engineCacheHeld: afterProcesses.some((row) => row.footprintBytes > 0) });
}
