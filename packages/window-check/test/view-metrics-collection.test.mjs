import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Session } from "../app.mjs";
import { playClient, playSession } from "../fixtures/endpoint-player.mjs";
import { stillFrame, stillFields } from "../still-recording.mjs";
import { policyOfSetting, readPolicy } from "../log-policy.mjs";
import * as viewMetrics from "../view-metrics-collection.mjs";
import { closeViewGroup, processFates, processGroupSteps, retainedRecordingLines, validateFootprintSample, collectViewReclaimMeasurements, collectViewStartAndMemory, openRecordedView,
  processStartSamples, TAB_PLACEMENT, viewContentFrameEvents, viewCardWithDifferentPluginTab,
  viewStartClockBracket, waitForViewReadiness, withDragTraceMode, withViewContentTrace } from "../view-metrics-collection.mjs";

const event = (name, surface, ts_us, mono_ns) => ({ event: name, ts_us, mono_ns,
  fields: { plugin: "fixture", surface } });

function sourceResult(documentTimeOriginMs = 1999, sourceNowMs = 0.2) {
  return { enabled: true, sourceClock: { documentTimeOriginMs, sourceNowMs, sourceResolutionMs: 1 } };
}

function clockReading(monoNs) {
  return { monoNs: String(monoNs), timeMs: Number(BigInt(monoNs)) / 1_000_000 };
}

function startBracket({ surface = "view-1", documentTimeOriginMs = 1999, sourceNowMs = 0.2,
  beforeMonoNs = 1_000_000_000, afterMonoNs = 1_001_000_000, hostPid = 41, window = "main", startResult } = {}) {
  const result = startResult ?? sourceResult(documentTimeOriginMs, sourceNowMs);
  return viewStartClockBracket(surface, result, clockReading(beforeMonoNs), clockReading(afterMonoNs), { hostPid, window });
}

// The descriptor of a plugin starts and stops the trace of its view with commands of the view, and the host answers them in the case.
const traceDescriptor = {
  plugin: "fixture",
  startContentTrace: (session, surface) => session.run("fixture.trace.start", {}, surface),
  stopContentTrace: (session, surface) => session.run("fixture.trace.stop", {}, surface),
};

/** A trace descriptor whose start changes the session as an application that is relaunched, or a window that is replaced, would. */
const changingStart = (change) => ({
  ...traceDescriptor,
  async startContentTrace(session, surface) {
    const start = await session.run("fixture.trace.start", {}, surface);
    change(session);
    return start;
  },
});

/** The event log of the host that the session reads. */
const hostLog = (session) => join(session.app.configDir, "logs", `host-1-${session.client.endpoint.pid}.jsonl`);

const contentFrameLine = () => `${JSON.stringify({ level: "debug", event:
  "plugin.fixture.view.content_frame", ts_us: 2_000_000, mono_ns: 3_000_000, page: "view-document-opaque", seq: 1,
  surface: "view-1", fields: { sequence: 1, documentTimeOriginMs: 1999, firstResizeAtMs: 0.2, resizeAtMs: 0.2, resizeCount: 1,
    frameTimeMs: 0.5, width: 300, height: 200 } })}\n`;

/** Writes still `index` of a recording, requested at `time` (ms) and completed 0.5ms later. */
function writeCapturedFrame(directory, index, time) {
  writeFileSync(join(directory, `frame-${String(index).padStart(4, "0")}.bgra`), stillFrame(time, time + 0.5));
}

test("generic view process samples preserve both event clocks and pair the first ready event", { timeout: 5000 }, () => {
  const rows = [event("host.trace.view.process-request", "view-1", 10, 1_000_000),
    event("host.trace.view.process-ready", "view-1", 20, 5_000_000)];
  assert.deepEqual(processStartSamples(rows, ["view-1"], "fixture"), [{
    requestAtMs: 1, readyAtMs: 5, requestTsUs: 10, readyTsUs: 20,
    requestMonoNs: 1_000_000, readyMonoNs: 5_000_000,
    requestEvent: rows[0], readyEvent: rows[1],
  }]);
  assert.throws(() => processStartSamples([rows[0]], ["view-1"], "fixture"), /no process-ready/);
  assert.throws(() => processStartSamples([rows[0], rows[0], rows[1]], ["view-1"], "fixture"), /duplicate process-request/);
  assert.throws(() => processStartSamples([rows[1], event("host.trace.view.process-request", "view-1", 30, 6_000_000)],
    ["view-1"], "fixture"), /precedes process-request/);
});

test("view anchor selection prefers the requested card and finds another card when needed", { timeout: 5000 }, () => {
  const grid = { cards: [
    { id: "target", active: "same", tabs: [{ id: "same", plugin: "fixture" }] },
    { id: "anchor", active: "other", tabs: [{ id: "other", plugin: "other-fixture" }] },
    { id: "preferred", active: "target-2", tabs: [
      { id: "target-2", plugin: "fixture" }, { id: "anchor-2", plugin: "other-fixture" },
    ] },
  ] };
  assert.equal(viewCardWithDifferentPluginTab(grid, "fixture", "preferred"), "preferred");
  assert.equal(viewCardWithDifferentPluginTab(grid, "fixture", "target"), "anchor");
  assert.throws(() => viewCardWithDifferentPluginTab({ cards: [{ id: "only", tabs: [
    { id: "same", plugin: "fixture" },
  ] }] }, "fixture"), /no card with an open plugin other than fixture/);
});

test("shared width drag plan uses the scratch card right boundary", { timeout: 5000 }, () => {
  const grid = { lines: { x: [0, 196, 503, 970, 1186] } };
  const card = { c0: 2, c1: 3 };
  const rightSidebar = { c0: 3, c1: 4, fixed: true };
  assert.equal(typeof viewMetrics.rightEdgeWidthDragPlan, "function",
    "the shared view collector does not expose its right-edge width drag plan");
  const plan = viewMetrics.rightEdgeWidthDragPlan(grid, card);
  assert.deepEqual(plan, { axis: "x", line: 3, dx: 80, dy: 0, ms: 500, times: 1 });
  assert.ok(plan.line > card.c0 && plan.line < grid.lines.x.length - 1,
    "the width drag must use the scratch card's interior right boundary");
  assert.equal(plan.line, rightSidebar.c0,
    "the width drag must move the boundary between the scratch card and fixed right sidebar");
  assert.notEqual(plan.line, 1, "line 1 is outside the actual c2-c3 scratch card");
});

test("shared width drag plan rejects invalid card boundaries", { timeout: 5000 }, () => {
  assert.equal(typeof viewMetrics.rightEdgeWidthDragPlan, "function",
    "the shared view collector does not expose its right-edge width drag plan");
  const grid = { lines: { x: [0, 196, 583, 970, 1186] } };
  assert.throws(() => viewMetrics.rightEdgeWidthDragPlan(grid, { c0: 3, c1: 2 }), /ordered grid columns/);
  assert.throws(() => viewMetrics.rightEdgeWidthDragPlan(grid, { c0: 2, c1: 4 }), /interior horizontal boundary/);
});

test("the exported lifecycle collector forwards the selected card ID to its first recording", { timeout: 5000 }, async (t) => {
  // The case holds the read of the grid, the start of the recording (which the display of the window refuses) and the open of the view in
  // the card that the grid selects: the host refuses the open, and the request names the selected card.
  const { session } = await playSession(t, Session, "window-check-view-start-card", "mygo");
  await assert.rejects(collectViewStartAndMemory(t, session, {
    plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready", readiness: async () => {},
    expectedContent: "target text", readContent: async () => "target text",
  }), /the host stops the open at the selected card/);
});

test("view totals are sampled at their declared count before extra process-start views open", { timeout: 5000 }, () => {
  // The one-view footprint comes before the other views open, the N-view footprint before the extra process-start views open, and the
  // content frames after both footprints.
  assert.deepEqual(processGroupSteps(3, 5).map(({ step, views }) => views === undefined ? step : `${step} ${views}`),
    ["open", "footprint 1", "open", "open", "footprint 3", "open", "open", "verify"]);
  assert.deepEqual(processGroupSteps(3, 2).map(({ step, views }) => views === undefined ? step : `${step} ${views}`),
    ["open", "footprint 1", "open", "open", "footprint 3", "verify"]);
  assert.throws(() => processGroupSteps(1, 5), /view count must be at least two/);
  assert.throws(() => processGroupSteps(3, 0), /process start sample count must be positive/);
});

test("a footprint sample needs process rows and ordered native clock bounds that match their times", { timeout: 5000 }, () => {
  const sample = { processes: [{ pid: 1, footprintBytes: 100 }], sampleClock: { before: clockReading(1_000_000), after: clockReading(2_000_000) } };
  assert.equal(validateFootprintSample(sample, "one-view"), sample);
  const refused = [
    [{ ...sample, processes: [] }, /one-view footprint sample must include at least one process/],
    [{ processes: sample.processes }, /one-view footprint sample must include monotonic clock bounds/],
    [{ ...sample, sampleClock: { before: sample.sampleClock.after, after: sample.sampleClock.before } }, /clock bounds are reversed/],
    [{ ...sample, sampleClock: { ...sample.sampleClock, after: { monoNs: "2000000", timeMs: 5 } } }, /after timeMs does not match monoNs/],
  ];
  for (const [value, message] of refused) assert.throws(() => validateFootprintSample(value, "one-view"), message);
});

test("a failed phase names its failure and the recording that each opened view retains", { timeout: 5000 }, () => {
  const failure = new Error("footprint read failed");
  const [first, ...retained] = retainedRecordingLines([{ surface: "view-1", recording: { directory: "/retained/view-1" } },
    { surface: "view-2", recording: { directory: null } }, { surface: "view-3" }], "one-view footprint sample", failure);
  assert.match(first, /^one-view footprint sample failed: Error: footprint read failed/);
  assert.deepEqual(retained, ["view recording retained at /retained/view-1 after one-view footprint sample failure"]);
});

test("view content-frame events preserve coalesced resize provenance", { timeout: 5000 }, () => {
  const row = { event: "plugin.fixture.view.content_frame", ts_us: 2_000_000,
    mono_ns: 3_000_000, page: "view-document-opaque", surface: "view-1", fields: { sequence: 0, documentTimeOriginMs: 1999,
      firstResizeAtMs: 0.1, resizeAtMs: 0.2, resizeCount: 2, frameTimeMs: 0.5, width: 300, height: 200 } };
  const anchor = startBracket();
  const [frame] = viewContentFrameEvents([row], "fixture", "view-1", anchor);
  assert.deepEqual({ firstResizeAtMs: frame.firstResizeAtMs, resizeAtMs: frame.resizeAtMs,
    resizeCount: frame.resizeCount }, { firstResizeAtMs: 0.1, resizeAtMs: 0.2, resizeCount: 2 });
  for (const fields of [
    { ...row.fields, firstResizeAtMs: undefined },
    { ...row.fields, firstResizeAtMs: 0.3 },
    { ...row.fields, resizeCount: 0 },
    { ...row.fields, resizeCount: 1.5 },
    { ...row.fields, resizeCount: 1 },
  ]) {
    assert.throws(() => viewContentFrameEvents([{ ...row, fields }], "fixture", "view-1", anchor),
      /firstResizeAtMs|resizeCount/);
  }
});

test("generic view content-frame events use the start source clock and preserve its interval", { timeout: 5000 }, () => {
  const row = { event: "plugin.fixture.view.content_frame", ts_us: 2_000_000,
    mono_ns: 3_000_000, page: "view-document-opaque", surface: "view-1", fields: { sequence: 4, documentTimeOriginMs: 1999,
      firstResizeAtMs: 0.2, resizeAtMs: 0.2, resizeCount: 1, frameTimeMs: 0.5, width: 300, height: 200 } };
  assert.deepEqual(viewContentFrameEvents([row], "fixture", "view-1", startBracket()), [{
    sequence: 4, width: 300, height: 200, firstResizeAtMs: 0.2, resizeAtMs: 0.2, resizeCount: 1, frameTimeMs: 0.5,
    timeRange: { lowerMs: 998.3, upperMs: 1003.3 },
    source: { documentTimeOriginMs: 1999, frameTimeMs: 0.5, sourceNowMs: 0.2, sourceResolutionMs: 1,
      clockBeforeMonoNs: "1000000000", clockAfterMonoNs: "1001000000", clockBeforeMs: 1000, clockAfterMs: 1001,
      hostPid: 41, window: "main", surface: "view-1", eventTsUs: 2_000_000, eventMonoNs: 3_000_000,
      eventPage: "view-document-opaque" },
  }]);
  assert.throws(() => viewContentFrameEvents([{ ...row, mono_ns: 0 }], "fixture", "view-1", startBracket()), /mono_ns/);
  assert.throws(() => viewContentFrameEvents([{ ...row, fields: { ...row.fields, width: 0 } }], "fixture", "view-1", startBracket()), /width/);
});

test("view content-frame mapping uses the successful start's native clock bracket", { timeout: 5000 }, () => {
  const row = { event: "plugin.fixture.view.content_frame", ts_us: 9_000_000,
    mono_ns: 99_000_000_000, page: "view-document-opaque", surface: "view-1", fields: { sequence: 0, documentTimeOriginMs: 1000,
      firstResizeAtMs: 10, resizeAtMs: 10, resizeCount: 1, frameTimeMs: 30, width: 300, height: 200 } };
  const bracket = startBracket({ documentTimeOriginMs: 1000, sourceNowMs: 20, afterMonoNs: 1_002_000_000 });
  assert.deepEqual(viewContentFrameEvents([row], "fixture", "view-1", bracket), [{
    sequence: 0, width: 300, height: 200, firstResizeAtMs: 10, resizeAtMs: 10, resizeCount: 1, frameTimeMs: 30,
    timeRange: { lowerMs: 1008, upperMs: 1014 },
    source: { documentTimeOriginMs: 1000, frameTimeMs: 30, sourceNowMs: 20, sourceResolutionMs: 1,
      clockBeforeMonoNs: "1000000000", clockAfterMonoNs: "1002000000", clockBeforeMs: 1000, clockAfterMs: 1002,
      hostPid: 41, window: "main", surface: "view-1",
      eventTsUs: 9_000_000, eventMonoNs: 99_000_000_000, eventPage: "view-document-opaque" },
  }]);
});

test("view start clock brackets require valid source identity and ordered native clock replies", { timeout: 5000 }, () => {
  const result = sourceResult();
  const bracket = startBracket({ startResult: result });
  assert.deepEqual(bracket, { surface: "view-1", hostPid: 41, window: "main", sourceClock: result.sourceClock,
    before: { monoNs: "1000000000", timeMs: 1000 }, after: { monoNs: "1001000000", timeMs: 1001 } });
  assert.throws(() => startBracket({ startResult: { enabled: true } }), /no sourceClock anchor/);
  assert.throws(() => startBracket({ startResult: { sourceClock: { ...result.sourceClock, extra: true } } }), /exactly the declared anchor fields/);
  assert.throws(() => startBracket({ startResult: { sourceClock: { ...result.sourceClock, sourceResolutionMs: 2 } } }), /declared 1 ms WebKit bound/);
  assert.throws(() => viewStartClockBracket("view-1", result, clockReading(2_000_000), clockReading(1_000_000),
    { hostPid: 41, window: "main" }), /must be later/);
  assert.throws(() => viewStartClockBracket("view-1", result, { monoNs: "01000000", timeMs: 1 }, clockReading(2_000_000),
    { hostPid: 41, window: "main" }), /invalid raw monotonic/);
  assert.throws(() => viewStartClockBracket("view-1", result, clockReading(1_000_000), clockReading(2_000_000),
    { hostPid: 0, window: "main" }), /process PID/);
  assert.throws(() => viewStartClockBracket("view-1", result, clockReading(1_000_000), clockReading(2_000_000),
    { hostPid: 41, window: "" }), /target window/);
});

test("generic view content-frame events accept the SDK's initial zero sequence", { timeout: 5000 }, () => {
  const rows = [0, 1].map((sequence, index) => ({ event: "plugin.fixture.view.content_frame",
    ts_us: 2_000_000 + index, mono_ns: 3_000_000 + index, page: "view-document-opaque", surface: "view-1",
    fields: { sequence, documentTimeOriginMs: 1999, firstResizeAtMs: 0.2 + index, resizeAtMs: 0.2 + index, resizeCount: 1,
      frameTimeMs: 0.5 + index, width: 300, height: 200 } }));
  assert.deepEqual(viewContentFrameEvents(rows, "fixture", "view-1", startBracket()).map(({ sequence }) => sequence), [0, 1]);
});

test("view cadence uses source frame times instead of variable host IPC arrival intervals", { timeout: 5000 }, () => {
  const rows = [1, 2].map((sequence, index) => ({ event: "plugin.fixture.view.content_frame", page: "view-document-opaque",
    ts_us: 2_100_000 + index * 100_000, mono_ns: 1_100_000_000 + index * 100_000_000,
    surface: "view-1", fields: { sequence, documentTimeOriginMs: 1999,
      firstResizeAtMs: 1 + index * 16, resizeAtMs: 1 + index * 16, resizeCount: 1, frameTimeMs: 1 + index * 16, width: 300, height: 200 } }));
  const frames = viewContentFrameEvents(rows, "fixture", "view-1", startBracket({ sourceNowMs: 0.2 }));
  assert.equal(frames[1].frameTimeMs - frames[0].frameTimeMs, 16);
  assert.equal(frames[1].timeRange.lowerMs - frames[0].timeRange.lowerMs, 16);
  assert.equal(frames[1].source.eventMonoNs - frames[0].source.eventMonoNs, 100_000_000);
});

// Each case holds the requests of the trace in their order: the read of the document clock, the native clock reads around the start
// and around five more reads of the document clock, the trace commands, and the flush of the log. The test writes the event log of
// the host that the gesture would have written.
test("generic content trace brackets the successful start command with native clock reads", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-trace-brackets", "mygo");
  const result = await withViewContentTrace({ diagnostic() {} }, session, traceDescriptor, "view-1", async (start) => {
    assert.deepEqual(start, { marker: { color: [255, 0, 255] },
      sourceClock: { documentTimeOriginMs: 1999, sourceNowMs: 0.2, sourceResolutionMs: 1 } });
    appendFileSync(hostLog(session), contentFrameLine());
    return { gestureEndedAtMs: 2 };
  });
  assert.equal(result.startBracket.surface, "view-1");
  assert.equal(result.startBracket.window, "main");
  assert.equal(result.startBracket.hostPid, session.client.endpoint.pid);
  assert.deepEqual(result.startBracket.before, { monoNs: "1000000000", timeMs: 1000 });
  assert.deepEqual(result.startBracket.after, { monoNs: "1010000000", timeMs: 1010 });
  assert.deepEqual(result.action, { gestureEndedAtMs: 2 });
  assert.deepEqual(result.start, { marker: { color: [255, 0, 255] },
    sourceClock: { documentTimeOriginMs: 1999, sourceNowMs: 0.2, sourceResolutionMs: 1 } });
  assert.deepEqual(result.contentFrames.map(({ sequence, width, height }) => ({ sequence, width, height })),
    [{ sequence: 1, width: 300, height: 200 }]);
  assert.deepEqual(result.stop, { sequence: 1 });
});

test("content trace maps document times through the narrowest clock bracket of the same document", { timeout: 5000 }, async (t) => {
  // The start bracket is 30 ms wide; the third clock read is 2 ms wide and reads 40.5 ms on the document clock. WebKit derives
  // performance.timeOrigin from the current wall clock at each read and reduces it to whole milliseconds, so one document can
  // report time origins one millisecond apart; the page identity names the document.
  const { session } = await playSession(t, Session, "window-check-trace-narrowest", "mygo");
  const result = await withViewContentTrace({ diagnostic() {} }, session, traceDescriptor, "view-1", async () => {});
  assert.deepEqual(result.startBracket.before, clockReading(1080000000));
  assert.deepEqual(result.startBracket.after, clockReading(1082000000));
  assert.equal(result.startBracket.sourceClock.sourceNowMs, 40.5);
  assert.equal(result.startBracket.sourceClock.documentTimeOriginMs, 1999, "the bracket left the time origin of the trace start");

  const other = await playSession(t, Session, "window-check-trace-other-document", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, other.session, traceDescriptor, "view-1", async () => {}),
    /core.surface.clock read another document than the trace start/);
});

test("content trace stops its diagnostic marker when the recorded action fails", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-trace-action-fails", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, session, traceDescriptor, "view-1", async () => {
    throw new Error("controlled action failure");
  }), /controlled action failure/);
});

test("content trace stops after a successful start returns invalid marker evidence", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-trace-invalid-marker", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, session, traceDescriptor, "view-1", async (start) => {
    assert.ok(start.marker, "marker reply is invalid");
  }), /marker reply is invalid/);
});

test("content trace stops when a successful start reply has no valid source clock anchor", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-trace-invalid-clock", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, session, traceDescriptor, "view-1", async () => {}), /no sourceClock anchor/);
});

test("content trace stops its observer when the post-start native clock read fails", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-trace-clock-fails", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, session, traceDescriptor, "view-1", async () => {}),
    /controlled post-start clock failure/);
});

test("content trace start failure does not read an after clock or stop an unstarted observer", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-trace-start-fails", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, session, traceDescriptor, "view-1", async () => {}), /controlled start failure/);
});

test("content trace bracket rejects a replaced client, changed host process or target window", { timeout: 5000 }, async (t) => {
  // The replaced client is a connection to another host, which sees the clock read after the start and the stop of the observer.
  const { session: replaced } = await playSession(t, Session, "window-check-trace-identity-client", "mygo");
  const { client: other } = await playClient(t, "window-check-trace-identity-client-replaced", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, replaced, changingStart((session) => { session.client = other; }), "view-1", async () => {}),
    /changed the session host client/);
  const { session: process } = await playSession(t, Session, "window-check-trace-identity-process", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, process, changingStart((session) => { session.client.endpoint.pid = 42; }), "view-1", async () => {}),
    /changed the host process/);
  const { session: window } = await playSession(t, Session, "window-check-trace-identity-window", "mygo");
  await assert.rejects(withViewContentTrace({ diagnostic() {} }, window, changingStart((session) => { session.window = "other-window"; }), "view-1", async () => {}),
    /changed the target window/);
});

test("shared readiness wrapper waits for the declared status exposure before reading it", { timeout: 5000 }, async (t) => {
  // The first reading of core.surfaces lists the view without the exposure of its status; the notification that follows registers
  // it, and only then does the readiness of the plugin read the status. The player fails a request that is not at its place.
  const { session } = await playSession(t, Session, "window-check-readiness-exposure", "mygo");
  const ready = await waitForViewReadiness(session, "view-a", {
    readinessStatus: "fixture.ready",
    readiness: (s) => s.get("fixture.ready"),
  });
  assert.equal(ready, "ready");
});

test("recorded views require a reader of the content value", { timeout: 5000 }, async (t) => {
  // The case window-check-open-idle holds no request: a view without a content reader that started its recording would fail the player.
  const { session } = await playSession(t, Session, "window-check-open-idle", "mygo");
  await assert.rejects(openRecordedView({}, session, {
    card: "card-1", plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready", readiness: async () => {},
    expectedContent: "fixture",
  }), /view content reader callback is required/);
});

test("recorded view observation window rejects nonpositive and nonfinite durations", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-open-idle", "mygo");
  for (const captureObservationWindowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(openRecordedView({}, session, {
      card: "card-1", plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready", readiness: async () => {},
      expectedContent: "fixture", readContent: async () => "fixture", captureObservationWindowMs,
    }), /finite positive duration/);
  }
});

/**
 * A session on the case `caseName`, in which the application opens view-1 in card-1 under a recording of stills planned and requested
 * at frameTimes and presents it. The writer of the recording leaves the frames and the list of stills in the folder that the case
 * names, and the application writes the events of the open of the view when it handles the request to open it.
 */
async function recordedViewSession(t, caseName, frameTimes) {
  const frames = realpathSync(mkdtempSync(join(tmpdir(), "view-recorded-content-")));
  t.after(() => rmSync(frames, { recursive: true, force: true }));
  for (const [index, time] of frameTimes.entries()) writeCapturedFrame(frames, index, time);
  const ns = (ms) => String(Math.round(ms * 1e6));
  const row = (index, time) => ({ index, planned: ns(time), requested: ns(time), completed: ns(time + 0.5),
    outcome: "written", error: null, frame: `frame-${String(index).padStart(4, "0")}.bgra`, windows: [7], requestedGap: 1000,
    machTimebaseNumerator: 1, machTimebaseDenominator: 1, ...stillFields(true, ns(time + 0.5)) });
  const stills = join(frames, "stills.jsonl");
  writeFileSync(stills, frameTimes.map((time, index) => JSON.stringify(row(index, time))).join("\n") + "\n");
  const { session, player } = await playSession(t, Session, caseName, "mygo", { values: { frames, stills } });
  player.events.on("request", (message) => {
    if (message.method !== "command.run" || message.params.name !== "core.card.add-tab") return;
    assert.equal(message.params.params.card, "card-1");
    appendFileSync(hostLog(session), `${JSON.stringify({ level: "debug", event:
      "host.trace.view.process-request", ts_us: 10, mono_ns: 6_000_000, seq: 1,
      fields: { plugin: "fixture", surface: "view-1" } })}\n${JSON.stringify({ level: "debug", event:
      "host.trace.view.process-ready", ts_us: 20, mono_ns: 7_000_000, seq: 2,
      fields: { plugin: "fixture", surface: "view-1" } })}\n`);
  });
  return session;
}

// The plugin of the view reads the status of its readiness and the content of its view with a status and a command of its view.
const fixtureView = {
  card: "card-1", plugin: "fixture", placement: TAB_PLACEMENT, readinessStatus: "fixture.ready",
  readiness: (session, surface) => session.get("fixture.ready", surface),
  readContent: (session, surface) => session.run("fixture.view.read", {}, surface),
};

test("direct recorded views take the display time of the presentation of the value as the content frame", { timeout: 5000 }, async (t) => {
  const s = await recordedViewSession(t, "window-check-recorded-view-direct", [4, 6]);
  const result = await openRecordedView({ diagnostic() {} }, s, { ...fixtureView, expectedContent: "target content", captureObservationWindowMs: 1 });
  // The content frame is a number that the host reports, the display time of the presentation after the value holds the content; the
  // recording is the log of the open and no time of a still is read.
  assert.deepEqual(result.contentFrame, { timeMs: 5,
    proof: { method: "value", expected: "target content", actual: "the target content line" } });
  assert.equal("anchor" in result, false, "the recorded view still reports an anchor");
  assert.deepEqual(Object.keys(result.recording), ["directory"]);
});

test("a recorded view whose value lacks the expected content stops its recording and fails", { timeout: 5000 }, async (t) => {
  // The case holds no presentation of the window: it holds the stop of the recording after the failure, at time 0.
  const s = await recordedViewSession(t, "window-check-recorded-view-content-lacks", [4, 6]);
  await assert.rejects(openRecordedView({ diagnostic() {} }, s, { ...fixtureView, expectedContent: "target content" }),
    /fixture view view-1 does not show "target content": "loading"/);
});

test("one recording reads the content value after readiness and defers the content frame past the footprint sample", { timeout: 5000 }, async (t) => {
  // The case holds one recording, the status exposure, the readiness, the content value, the presentation, the stop of the recording
  // 20 ms after it, the reads of the view, and the close of the view by its cleanup.
  const s = await recordedViewSession(t, "window-check-recorded-view-deferred", [0.5, 5.5, 10, 13]);
  const result = await openRecordedView({ diagnostic: () => {} }, s, { ...fixtureView, params: { path: "file.txt" },
    expectedContent: "SOKSAK FIXTURE", captureObservationWindowMs: 20, deferContentVerification: true });
  assert.equal("contentFrame" in result, false, "the deferred content frame was selected before the footprint sample");
  Object.assign(result, await result.verifyContent());
  assert.equal(result.surface, "view-1");
  assert.equal(result.openedPid, 3141);
  assert.deepEqual(result.contentFrame, { timeMs: 12,
    proof: { method: "value", expected: "SOKSAK FIXTURE", actual: "SOKSAK FIXTURE" } });
  // The opened view has a cleanup owner, the last of the cleanups of the session, which closes the view.
  await s.cleanups.at(-1)();
});

test("view process-group close records observed history and every original PID", { timeout: 5000 }, async (t) => {
  // The case holds the requests of the close in their order: the read of the processes, the clock, the close of the view, the waits for
  // the registry and host.window without the view, the exit of the process that the host reports ending, and the clock. The same close
  // is read twice.
  const { session } = await playSession(t, Session, "window-check-close-group", "mygo");
  const beforeProcesses = [{ pid: 4101, footprintBytes: 1_000_000 }];
  const closedViews = [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }];
  const result = await closeViewGroup({ diagnostic() {} }, session, { placement: TAB_PLACEMENT, surfaces: ["view-1"], beforeProcesses, closedViews });
  assert.deepEqual(result, { beforeProcesses, afterProcesses: [{ pid: 4101, footprintBytes: 0 }],
    elapsedMs: 1, engineCacheHeld: false, closedViews });
  await assert.rejects(closeViewGroup({ diagnostic() {} }, session, {
    placement: TAB_PLACEMENT, surfaces: ["view-1"], beforeProcesses,
    closedViews: [{ surface: "view-1", rootHistoryEntries: 2, documents: [] }],
  }), /root session history/);
});

test("the reclaim close reads the processes that remain and awaits only the exit of the processes that host.window reports ending", { timeout: 5000 }, () => {
  // After the close, 4101 is ending, 4102 holds a page of another surface, 4103 remains without a page and 4104 has exited.
  const closed = { documents: [{ surface: "other", document: "", process: 4102 }],
    pagelessProcesses: [{ pid: 4101, ending: true }, { pid: 4103, ending: false }] };
  assert.deepEqual(processFates([4101, 4102, 4103, 4104].map((pid) => ({ pid, footprintBytes: 1_000_000 })), closed), [
    { pid: 4101, fate: "ending" }, { pid: 4102, fate: "page" }, { pid: 4103, fate: "no page" }, { pid: 4104, fate: "exited" }]);
});

test("the reclaim close refuses a host.window that does not report the processes without a page", { timeout: 5000 }, () => {
  assert.throws(() => processFates([{ pid: 4101, footprintBytes: 1 }], { documents: [], pagelessProcesses: null }),
    /does not report the processes without a page/);
});

test("the end of a reclaim exit wait fails the close with its reason", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-close-group-exit-fails", "mygo");
  await assert.rejects(closeViewGroup({ diagnostic() {} }, session, { placement: TAB_PLACEMENT, surfaces: ["view-1"],
    beforeProcesses: [{ pid: 4101, footprintBytes: 1 }], closedViews: [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }] }),
  { message: "mygo diagnostics.process.exit: process 4101 did not exit before the endpoint connection of the request closed" });
});

test("a view descriptor without a placement is refused by every collector with an error that names the descriptor", { timeout: 5000 }, async (t) => {
  const descriptor = { plugin: "fixture", readinessStatus: "fixture.ready", readiness: async () => {}, expectedContent: "fixture",
    language: "en-US" };
  const refused = { message: "view descriptor fixture has no placement with the functions card, open and close" };
  // The case window-check-open-idle holds no request: a collector that used the session before it refused the descriptor fails the player.
  const { session: untouched } = await playSession(t, Session, "window-check-open-idle", "mygo");
  await assert.rejects(openRecordedView(t, untouched, { card: "card-1", ...descriptor }), refused);
  await assert.rejects(collectViewStartAndMemory(t, untouched, descriptor), refused);
  await assert.rejects(collectViewReclaimMeasurements(t, untouched, descriptor, [{ surface: "view-1" }]), refused);
  await assert.rejects(openRecordedView(t, untouched, { card: "card-1", ...descriptor, placement: { card() {}, open() {} } }), refused);
  await assert.rejects(closeViewGroup(t, untouched, { surfaces: ["view-1"], beforeProcesses: [{ pid: 1, footprintBytes: 1 }],
    closedViews: [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }] }),
  { message: "view close has no placement with the functions card, open and close" });
});

test("the tab placement chooses a card with a tab of another plugin, adds the view as a tab and closes it as a tab", { timeout: 5000 }, async (t) => {
  const grid = { cards: [{ id: "card-1", tabs: [{ id: "other", plugin: "other-fixture" }] }] };
  assert.equal(TAB_PLACEMENT.card(grid, "fixture", "card-1"), viewCardWithDifferentPluginTab(grid, "fixture", "card-1"));
  // The case holds the add of the tab, its close and the wait until the registry lists no view, and then a close that the host
  // reports as not closed.
  const { session } = await playSession(t, Session, "window-check-tab-placement", "mygo");
  assert.equal(await TAB_PLACEMENT.open(session, { card: "card-1", plugin: "fixture", params: { path: "a.txt" } }), "view-1");
  await TAB_PLACEMENT.close(session, "view-1", { cleanup: false });
  await assert.rejects(TAB_PLACEMENT.close(session, "view-1", { cleanup: true }), { message: /^view view-1 did not close during cleanup\n/ });
  assert.ok(Object.isFrozen(TAB_PLACEMENT));
});

// The host writes the policy file of the setting diagnostics.log when it handles core.settings.set, and the measured drag waits for it;
// a test writes the file as the host does when the player has received the command.
async function dragTraceSession(t, caseName, logPolicy) {
  const { session, player } = await playSession(t, Session, caseName, "mygo");
  const write = (log) => writeFileSync(join(session.app.configDir, "log-policy.json"), JSON.stringify(policyOfSetting(log)));
  write(logPolicy);
  player.events.on("request", (message) => {
    if (message.method === "command.run" && message.params.name === "core.settings.set") write(message.params.params.patch["diagnostics.log"]);
  });
  return session;
}

test("a measured drag stores only the frame class without the performance trace and restores both settings", { timeout: 5000 }, async (t) => {
  const logPolicy = { frame: "trace", call: "debug" };
  const session = await dragTraceSession(t, "window-check-drag-mode", logPolicy);
  const result = await withDragTraceMode(session, async () => {
    const during = (await session.get("core.settings")).values;
    assert.equal(during["diagnostics.performance"], false);
    assert.deepEqual(during["diagnostics.log"], { frame: "trace" });
    assert.deepEqual(readPolicy(session.app.configDir).classes, policyOfSetting({ frame: "trace" }).classes);
    return { gesture: "captured" };
  });
  assert.deepEqual(result, {
    result: { gesture: "captured" },
    phaseMode: {
      performanceTrace: { before: true, during: false, after: true },
      logPolicy: { before: logPolicy, during: { frame: "trace" }, after: logPolicy },
    },
  });
  assert.deepEqual(readPolicy(session.app.configDir).classes, policyOfSetting(logPolicy).classes);
});

test("a measured drag keeps the failure of its action and of the restoration", { timeout: 5000 }, async (t) => {
  const session = await dragTraceSession(t, "window-check-drag-mode-restore-fails", { frame: "trace" });
  const actionError = new Error("drag evidence failed");
  await assert.rejects(withDragTraceMode(session, async () => { throw actionError; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], actionError);
    assert.match(error.errors[1].message, /trace setting restoration failed/);
    return true;
  });
});

test("a measured drag restores the settings when the settings cannot be read after it", { timeout: 5000 }, async (t) => {
  const session = await dragTraceSession(t, "window-check-drag-mode-read-fails", { frame: "trace", call: "debug" });
  await assert.rejects(withDragTraceMode(session, async () => "captured"), /post-action settings read failed/);
});

test("a measured drag refuses a log policy without the frame trace and changes nothing", { timeout: 5000 }, async (t) => {
  const session = await dragTraceSession(t, "window-check-drag-mode-no-frame-trace", {});
  await assert.rejects(withDragTraceMode(session, async () => "captured"), /drag requires the frame trace log policy/);
});

test("a measured drag keeps a falsy rejection of its action", { timeout: 5000 }, async (t) => {
  for (const failure of [null, undefined, 0]) {
    const session = await dragTraceSession(t, "window-check-drag-mode-action-throws", { frame: "trace" });
    await assert.rejects(withDragTraceMode(session, async () => { throw failure; }), (error) => error === failure);
  }
});

test("reclaim finishes the content verification of the same live recorded view before its footprint/close interval begins", { timeout: 5000 }, async (t) => {
  // The case holds the open of the view with its content verification deferred, and then the measured close of its process group: the
  // view is open when its content frame is kept, and the close of the group follows.
  const s = await recordedViewSession(t, "window-check-recorded-view-verified-close", [0.5, 5.5, 10, 13]);
  const view = await openRecordedView({ diagnostic: () => {} }, s, { ...fixtureView, expectedContent: "SOKSAK FIXTURE",
    captureObservationWindowMs: 20, deferContentVerification: true });
  assert.equal("contentFrame" in view, false);
  const result = await viewMetrics.closeVerifiedRecordedViewGroup([view], () => closeViewGroup({ diagnostic() {} }, s, {
    placement: TAB_PLACEMENT, surfaces: ["view-1"], beforeProcesses: [{ pid: 3141, footprintBytes: 1_000_000 }],
    closedViews: [{ surface: "view-1", rootHistoryEntries: 1, documents: [] }] }));
  assert.deepEqual(view.contentFrame, { timeMs: 12, proof: { method: "value", expected: "SOKSAK FIXTURE", actual: "SOKSAK FIXTURE" } });
  assert.deepEqual(result.afterProcesses, [{ pid: 3141, footprintBytes: 0 }]);
  assert.equal(view.surface, "view-1");
});

test("reclaim preserves a failed content verification without closing or substituting a target", { timeout: 5000 }, async (t) => {
  // The case window-check-open-idle holds no request: a close of the group would fail the player. A view without its deferred
  // verifier is refused before the close.
  const { session } = await playSession(t, Session, "window-check-open-idle", "mygo");
  await assert.rejects(viewMetrics.closeVerifiedRecordedViewGroup([{ surface: "original" }], () => session.run("core.tab.close", { tab: "original" })),
    /view original has no deferred content verifier/);
});

test("actual reclaim collector verifies content before the existing measured close group", { timeout: 5000 }, async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../view-metrics-collection.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function collectViewReclaimMeasurements("), source.indexOf("/** Executes process, memory"));
  assert.ok(body.includes("closeVerifiedRecordedViewGroup(views,"), "actual initial and reopened reclaim groups must verify content before the measured close");
  assert.equal(body.includes("const sample = await closeInitial([view]);\n    await verifyOpenedViewContent(view);"), false,
    "live verification after the measured close is forbidden");
});
